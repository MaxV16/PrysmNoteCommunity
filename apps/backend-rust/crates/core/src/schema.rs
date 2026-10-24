//! First-boot schema provisioning for a fresh PostgreSQL database.
//!
//! Up to now the schema was created by the Python backend's startup
//! `ensure_schema`. With the backend cut over to Rust, the server owns that
//! bootstrap: [`ensure_schema`] applies the embedded DDL (`sql/core_schema.sql`,
//! captured from the live reference schema) exactly once when the database has
//! no `users` table.
//!
//! Existing databases (including production, which Python already provisioned)
//! are detected by that marker and skipped, so this is a no-op on every boot
//! after the first. A blocking transaction-scoped advisory lock serializes
//! concurrent workers so two processes cannot race the bootstrap.

use sqlx::PgPool;

/// Transaction-scoped advisory lock key for schema provisioning. Distinct from
/// the background-loop leader key so the two never contend.
const PROVISION_LOCK_KEY: i64 = 0x7072_7973_6d73_6368; // "prysm sch"

const CORE_SCHEMA_SQL: &str = include_str!("../sql/core_schema.sql");

/// Idempotent additive migrations, applied on every boot after the initial
/// bootstrap check. On a fresh database these are no-ops (the bootstrap already
/// created the columns/table); on an existing database (production, which the
/// old backend provisioned) they add the inactivity lifecycle columns and the
/// audit table. Every statement is `IF NOT EXISTS`, so reruns are safe and
/// multi-worker boots are serialized by the advisory lock below.
const CORE_MIGRATIONS_SQL: &str = r#"
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_active_at timestamp with time zone;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS inactivity_warned_at timestamp with time zone;

CREATE TABLE IF NOT EXISTS public.account_deletions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    email_hash character varying(64) NOT NULL,
    reason character varying(32) NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_account_deletions_email_hash ON public.account_deletions USING btree (email_hash);
CREATE INDEX IF NOT EXISTS ix_account_deletions_user_id ON public.account_deletions USING btree (user_id);

-- User image uploads for task descriptions and subtasks. Bytes live in the
-- database so the normal Postgres backup covers them with no extra volume.
CREATE TABLE IF NOT EXISTS public.uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    mime character varying(100) NOT NULL,
    filename character varying(255) NOT NULL,
    size integer NOT NULL,
    data bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS ix_uploads_user_id ON public.uploads USING btree (user_id);

ALTER TABLE public.uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uploads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_isolation ON public.uploads;
CREATE POLICY user_isolation ON public.uploads USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));

-- user_tokens must NOT be row-level-secured: OAuth tokens are Fernet-encrypted
-- and every query scopes by user_id, while core background loops (the calendar
-- pull) read tokens across users on the app pool with no RLS context. A legacy
-- FORCE with no matching policy rejected every token write ("new row violates
-- row-level security policy for table user_tokens"), so clear it on existing
-- databases; fresh databases no longer enable it at all.
ALTER TABLE public.user_tokens NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_tokens DISABLE ROW LEVEL SECURITY;

-- Finance lite extensions: a free-text note, who it is owed to/from, a due
-- date, a settled marker and an optional linked task. `receivable` marks money
-- someone owes the user (see the Owed to me view + the AI receivables tools).
ALTER TABLE public.financial_items ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.financial_items ADD COLUMN IF NOT EXISTS counterparty character varying(200);
ALTER TABLE public.financial_items ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE public.financial_items ADD COLUMN IF NOT EXISTS settled_at date;
ALTER TABLE public.financial_items ADD COLUMN IF NOT EXISTS receivable boolean NOT NULL DEFAULT false;
ALTER TABLE public.financial_items ADD COLUMN IF NOT EXISTS linked_task_id uuid;

-- Per-member task sharing: a NULL user_id is a whole-team share, a set value
-- targets one teammate (see task::access_condition + the drawer share popover).
ALTER TABLE public.task_shares ADD COLUMN IF NOT EXISTS user_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'task_shares_user_id_fkey'
    ) THEN
        ALTER TABLE public.task_shares
            ADD CONSTRAINT task_shares_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_task_shares_user ON public.task_shares USING btree (user_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'financial_items_linked_task_id_fkey'
    ) THEN
        ALTER TABLE public.financial_items
            ADD CONSTRAINT financial_items_linked_task_id_fkey
            FOREIGN KEY (linked_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_financial_items_user_due ON public.financial_items USING btree (user_id, due_date);

-- The MCP PAT lookup runs pre-auth on the BYPASSRLS system pool because
-- api_tokens is FORCE ROW LEVEL SECURITY and the app role is NOBYPASSRLS (the
-- app pool would see zero rows and reject every valid token). zz-init-roles.sh
-- grants the system role via default privileges, but a database provisioned
-- before that block existed lacks the grant; re-assert it here (the app role
-- owns the table, so it may grant). No-op on databases without the system role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prysm_system') THEN
        GRANT SELECT, UPDATE ON public.api_tokens TO prysm_system;
        -- The MCP OAuth token endpoint (crates/ee/src/mcp_oauth.rs) reads a
        -- user's token_version on the system pool, because an authorization
        -- code is exchanged before any user context exists. Without this grant
        -- the exchange silently failed with "invalid_grant" right after the
        -- browser approval, so no AI app could ever finish connecting.
        GRANT SELECT ON public.users TO prysm_system;
    END IF;
END $$;

-- Recurring tasks: occurrence rows used to be stored in the subtask column
-- (parent_task_id), so the UI hid them as subtasks and they never showed on the
-- timeline. Occurrences now point at their template through a dedicated
-- recurrence_parent_id, leaving parent_task_id exclusively for real subtasks.
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS recurrence_parent_id uuid;

-- Per-task scheduled reminders: a one-off UTC fire time plus the delivery
-- channels chosen for that task. reminder_enabled stays the master switch and
-- existing rows keep their current behaviour (no reminder_at means the legacy
-- due-date/global-time engine handles them).
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS reminder_at timestamp with time zone;
-- Older databases (and the old bootstrap SQL) created is_all_day NOT NULL with
-- no default, so inserts that omit it (the reminder engine test, scripts) fail.
ALTER TABLE public.tasks ALTER COLUMN is_all_day SET DEFAULT false;
ALTER TABLE public.tasks ALTER COLUMN is_archived SET DEFAULT false;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS reminder_inapp boolean NOT NULL DEFAULT true;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS reminder_push boolean NOT NULL DEFAULT false;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS reminder_email boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_tasks_reminder_at ON public.tasks USING btree (reminder_at) WHERE reminder_at IS NOT NULL AND deleted_at IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tasks_recurrence_parent_id_fkey'
    ) THEN
        ALTER TABLE public.tasks
            ADD CONSTRAINT tasks_recurrence_parent_id_fkey
            FOREIGN KEY (recurrence_parent_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_parent ON public.tasks USING btree (recurrence_parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_parent_start_date ON public.tasks USING btree (recurrence_parent_id, start_date);

-- Backfill existing occurrence rows from parent_task_id into
-- recurrence_parent_id. A real subtask never has a start_date (insert_subtask
-- does not set one) while an occurrence always does, so start_date IS NOT NULL
-- distinguishes them. tasks is FORCE ROW LEVEL SECURITY; the app role owns the
-- table, so clear FORCE for the backfill and re-enable it in the same
-- transaction.
ALTER TABLE public.tasks NO FORCE ROW LEVEL SECURITY;
UPDATE public.tasks
   SET recurrence_parent_id = parent_task_id,
       parent_task_id = NULL
 WHERE parent_task_id IS NOT NULL
   AND start_date IS NOT NULL
   AND parent_task_id IN (SELECT id FROM public.tasks WHERE recurrence_rule IS NOT NULL);
ALTER TABLE public.tasks FORCE ROW LEVEL SECURITY;

-- Legacy occurrence rows were also missing their template's list and board
-- section (the columns stayed NULL) and never got the template's tags, so once
-- these rows started showing as individual tasks they were still not where the
-- user expected. Fill the gaps from each occurrence's template. Idempotent: only
-- blank fields and missing tags are filled. Both tables are FORCE ROW LEVEL
-- SECURITY, so clear FORCE around the bulk writes and re-enable it in the same
-- transaction.
ALTER TABLE public.tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.task_tags NO FORCE ROW LEVEL SECURITY;
UPDATE public.tasks o
   SET list_id = COALESCE(o.list_id, t.list_id),
       board_section_id = COALESCE(o.board_section_id, t.board_section_id)
  FROM public.tasks t
 WHERE o.recurrence_parent_id = t.id
   AND (o.list_id IS NULL OR o.board_section_id IS NULL);
INSERT INTO public.task_tags (task_id, tag_id)
SELECT o.id, tt.tag_id
  FROM public.tasks o
  JOIN public.task_tags tt ON tt.task_id = o.recurrence_parent_id
 WHERE o.recurrence_parent_id IS NOT NULL
ON CONFLICT DO NOTHING;
ALTER TABLE public.task_tags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tasks FORCE ROW LEVEL SECURITY;
"#;

/// Provisions the core schema on a fresh database.
///
/// Runs the embedded bootstrap DDL only when `public.users` is absent (tries the
/// system role pool first, the provisioning role in some deployments, then the
/// app pool), then applies the idempotent additive migrations. The migrations
/// run as the **app** role: on production the app role owns the tables and
/// `zz-init-roles.sh` grants the system role access to objects the app role
/// creates, so new tables/columns are usable by both. Running them as the system
/// role would leave new objects system-owned and the app role without access.
pub async fn ensure_schema(pool: &PgPool, system_pool: &PgPool) -> Result<(), sqlx::Error> {
    match bootstrap(system_pool).await {
        Ok(()) => {}
        Err(err) => {
            tracing::warn!("schema bootstrap via the system pool failed ({err}); retrying on the app pool");
            bootstrap(pool).await?;
        }
    }
    match migrate(pool).await {
        Ok(()) => Ok(()),
        Err(err) => {
            tracing::warn!("schema migrations via the app pool failed ({err}); retrying on the system pool");
            migrate(system_pool).await
        }
    }
}

/// Create the full bootstrap schema only when `public.users` is absent.
async fn bootstrap(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    lock(&mut tx).await?;
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('public.users') IS NOT NULL")
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        tracing::info!("provisioning the core schema on a fresh database");
        sqlx::raw_sql(CORE_SCHEMA_SQL).execute(&mut *tx).await?;
    }
    tx.commit().await
}

/// Apply the idempotent additive migrations on every boot.
async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    lock(&mut tx).await?;
    sqlx::raw_sql(CORE_MIGRATIONS_SQL).execute(&mut *tx).await?;
    tx.commit().await
}

async fn lock(tx: &mut sqlx::PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(PROVISION_LOCK_KEY)
        .execute(&mut *tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `user_tokens` must stay outside row-level security: the core calendar
    /// pull reads tokens across users on the app pool with no RLS context, and
    /// a legacy FORCE with no policy rejected every token write ("new row
    /// violates row-level security policy for table user_tokens"), which broke
    /// GitHub/Slack/email OAuth connects on fresh databases.
    #[test]
    fn user_tokens_is_not_row_level_secured() {
        assert!(!CORE_SCHEMA_SQL.contains("user_tokens ENABLE ROW LEVEL SECURITY"));
        assert!(!CORE_SCHEMA_SQL.contains("user_tokens FORCE ROW LEVEL SECURITY"));
        assert!(CORE_MIGRATIONS_SQL.contains("user_tokens NO FORCE ROW LEVEL SECURITY"));
        assert!(CORE_MIGRATIONS_SQL.contains("user_tokens DISABLE ROW LEVEL SECURITY"));
    }
}
