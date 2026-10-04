-- Core schema bootstrap for a FRESH PostgreSQL database.
-- Generated from the live reference schema (pg_dump --schema-only). Executed
-- once at startup by prysm-core when the database has no `users` table.
-- Extensions first, then enum types and the RLS helper functions, then the
-- tables, constraints and policies.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$ BEGIN
    CREATE TYPE public.sync_action AS ENUM ('push', 'pull', 'delete');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE public.task_link_type AS ENUM ('depends_on', 'related', 'blocks', 'duplicates');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE public.task_status AS ENUM ('backlog', 'todo', 'in_progress', 'done', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS helper functions. On a live database these are owned by the system role,
-- so a pg_dump run as the app role omits them; define them up front, before any
-- policy references them. Bodies are not validated here (check_function_bodies
-- is off), so is_team_member may reference a table created later in this file.
SET check_function_bodies = false;
CREATE OR REPLACE FUNCTION public.rls_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION public.rls_user_email() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.user_email', true), '') $$;
CREATE OR REPLACE FUNCTION public.is_team_member(p_team_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    SET row_security = off
    AS $$ SELECT EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = p_team_id AND tm.user_id = p_user_id) $$;

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(20) NOT NULL,
    cache_key character varying(64) NOT NULL,
    response text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY public.ai_cache FORCE ROW LEVEL SECURITY;


--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    role character varying(10) NOT NULL,
    content text NOT NULL,
    tool_calls jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ai_conversations FORCE ROW LEVEL SECURITY;


--
-- Name: ai_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    content text NOT NULL,
    category character varying(32) NOT NULL,
    embedding public.vector(1536),
    source_session_id uuid,
    is_active boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ai_memories FORCE ROW LEVEL SECURITY;


--
-- Name: ai_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ai_sessions FORCE ROW LEVEL SECURITY;


--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(20) NOT NULL,
    month timestamp with time zone NOT NULL,
    input_tokens bigint NOT NULL,
    output_tokens bigint NOT NULL,
    cached_input_tokens bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ai_usage FORCE ROW LEVEL SECURITY;


--
-- Name: analytics_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_daily (
    day date NOT NULL,
    event character varying(64) NOT NULL,
    count integer NOT NULL,
    unique_users integer NOT NULL
);


--
-- Name: analytics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_events (
    id bigint NOT NULL,
    user_id uuid,
    event character varying(64) NOT NULL,
    properties jsonb NOT NULL,
    session_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.analytics_events FORCE ROW LEVEL SECURITY;


--
-- Name: analytics_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.analytics_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: analytics_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.analytics_events_id_seq OWNED BY public.analytics_events.id;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(20) NOT NULL,
    encrypted_key bytea NOT NULL,
    key_prefix character varying(10),
    is_active boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.api_keys FORCE ROW LEVEL SECURITY;


--
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(80) NOT NULL,
    token_hash character varying(64) NOT NULL,
    prefix character varying(12) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY public.api_tokens FORCE ROW LEVEL SECURITY;


--
-- Name: board_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.board_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    list_id uuid,
    kind character varying(16) NOT NULL,
    title character varying(200) NOT NULL,
    color character varying(16),
    status character varying(16),
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.board_sections FORCE ROW LEVEL SECURITY;


--
-- Name: calendar_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    task_id uuid,
    google_event_id character varying(500) NOT NULL,
    calendar_id character varying(500) NOT NULL,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_action public.sync_action NOT NULL
);

ALTER TABLE ONLY public.calendar_events FORCE ROW LEVEL SECURITY;


--
-- Name: financial_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.financial_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    direction character varying(10) NOT NULL,
    amount numeric(12,2) NOT NULL,
    kind character varying(10) NOT NULL,
    start_date date,
    end_date date,
    frequency character varying(10),
    next_date date,
    payee character varying(200),
    category character varying(100),
    principal numeric(12,2),
    remaining_balance numeric(12,2),
    interest_rate numeric(6,3),
    paid_off_at date,
    repeat_count integer,
    frequency_unit character varying(10),
    frequency_interval integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.financial_items FORCE ROW LEVEL SECURITY;


--
-- Name: financial_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.financial_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    external_id character varying(255),
    date date NOT NULL,
    amount numeric(12,2) NOT NULL,
    counterparty character varying(255),
    description text,
    category character varying(100),
    source character varying(20) NOT NULL,
    item_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.financial_transactions FORCE ROW LEVEL SECURITY;


--
-- Name: habit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.habit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    habit_id uuid NOT NULL,
    user_id uuid NOT NULL,
    completed_at date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.habit_logs FORCE ROW LEVEL SECURITY;


--
-- Name: habits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.habits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title character varying(500) NOT NULL,
    frequency character varying(20) NOT NULL,
    target_count integer NOT NULL,
    color character varying(7),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.habits FORCE ROW LEVEL SECURITY;


--
-- Name: lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.lists FORCE ROW LEVEL SECURITY;


--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id character varying(64) NOT NULL,
    user_id uuid NOT NULL,
    import_batch_id uuid,
    title character varying(300) NOT NULL,
    content text NOT NULL,
    color character varying(16) NOT NULL,
    x double precision NOT NULL,
    y double precision NOT NULL,
    width double precision NOT NULL,
    height double precision NOT NULL,
    minimized boolean NOT NULL,
    open boolean NOT NULL,
    sort integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notes FORCE ROW LEVEL SECURITY;


--
-- Name: notification_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    task_id uuid,
    kind character varying(24) NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notification_logs FORCE ROW LEVEL SECURITY;


--
-- Name: passkeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passkeys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    credential_id character varying(255) NOT NULL,
    public_key bytea NOT NULL,
    sign_count integer DEFAULT 0 NOT NULL,
    transports character varying(64),
    aaguid character varying(64),
    name character varying(100),
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.passkeys FORCE ROW LEVEL SECURITY;


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.push_subscriptions FORCE ROW LEVEL SECURITY;


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(50) NOT NULL,
    color character varying(7)
);

ALTER TABLE ONLY public.tags FORCE ROW LEVEL SECURITY;


--
-- Name: task_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_embeddings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    embedding public.vector(1536),
    source_hash character varying(64),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.task_embeddings FORCE ROW LEVEL SECURITY;


--
-- Name: task_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_task_id uuid NOT NULL,
    target_task_id uuid NOT NULL,
    link_type public.task_link_type NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.task_links FORCE ROW LEVEL SECURITY;


--
-- Name: task_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    team_id uuid NOT NULL,
    shared_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.task_shares FORCE ROW LEVEL SECURITY;


--
-- Name: task_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_tags (
    task_id uuid NOT NULL,
    tag_id uuid NOT NULL
);

ALTER TABLE ONLY public.task_tags FORCE ROW LEVEL SECURITY;


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    parent_task_id uuid,
    board_section_id uuid,
    board_order integer,
    title character varying(5000) NOT NULL,
    description text,
    status public.task_status NOT NULL,
    priority smallint NOT NULL,
    start_date date,
    due_date date,
    start_time time without time zone,
    end_time time without time zone,
    is_all_day boolean NOT NULL,
    estimated_minutes integer,
    recurrence_rule text,
    recurrence_end_date date,
    recurrence_last_expanded_at timestamp with time zone,
    import_batch_id uuid,
    sort_order integer NOT NULL,
    is_archived boolean NOT NULL,
    deleted_at timestamp with time zone,
    list_id uuid,
    completed_at timestamp with time zone,
    reminder_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.tasks FORCE ROW LEVEL SECURITY;


--
-- Name: team_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    invited_by uuid NOT NULL,
    email character varying(255) NOT NULL,
    role character varying(16) NOT NULL,
    token character varying(64) NOT NULL,
    status character varying(16) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.team_invites FORCE ROW LEVEL SECURITY;


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(16) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.team_members FORCE ROW LEVEL SECURITY;


--
-- Name: team_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.team_projects FORCE ROW LEVEL SECURITY;


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.teams FORCE ROW LEVEL SECURITY;


--
-- Name: token_blacklist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_blacklist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    jti character varying(64) NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_notification_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notification_prefs (
    user_id uuid NOT NULL,
    inapp_reminders boolean DEFAULT true NOT NULL,
    reminder_time character varying(5) DEFAULT '20:00'::character varying NOT NULL,
    email_reminders boolean DEFAULT false NOT NULL,
    due_alerts boolean NOT NULL,
    email_digest boolean NOT NULL,
    push_enabled boolean NOT NULL,
    sound boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.user_notification_prefs FORCE ROW LEVEL SECURITY;


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    key character varying(64) NOT NULL,
    value json,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.user_preferences FORCE ROW LEVEL SECURITY;


--
-- Name: user_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(50) NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    token_uri character varying(255),
    scopes character varying(500),
    expiry timestamp with time zone,
    last_pulled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255),
    display_name character varying(100),
    provider character varying(20),
    email_verified boolean DEFAULT false NOT NULL,
    token_version integer DEFAULT 0 NOT NULL,
    last_active_at timestamp with time zone,
    inactivity_warned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_deletions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    email_hash character varying(64) NOT NULL,
    reason character varying(32) NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: watchlist_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchlist_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tmdb_id integer NOT NULL,
    media_type character varying(8) NOT NULL,
    title character varying(500) NOT NULL,
    poster_path character varying(500),
    release_year integer,
    status character varying(16) NOT NULL,
    is_theatrical boolean DEFAULT false NOT NULL,
    rating smallint,
    notes text,
    watched_at date,
    upcoming_json jsonb,
    providers_json jsonb,
    metadata_fetched_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.watchlist_items FORCE ROW LEVEL SECURITY;


--
-- Name: analytics_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events ALTER COLUMN id SET DEFAULT nextval('public.analytics_events_id_seq'::regclass);


--
-- Name: ai_cache ai_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cache
    ADD CONSTRAINT ai_cache_pkey PRIMARY KEY (id);


--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);


--
-- Name: ai_memories ai_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_memories
    ADD CONSTRAINT ai_memories_pkey PRIMARY KEY (id);


--
-- Name: ai_sessions ai_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_sessions
    ADD CONSTRAINT ai_sessions_pkey PRIMARY KEY (id);


--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);


--
-- Name: analytics_daily analytics_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_daily
    ADD CONSTRAINT analytics_daily_pkey PRIMARY KEY (day, event);


--
-- Name: analytics_events analytics_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: board_sections board_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_sections
    ADD CONSTRAINT board_sections_pkey PRIMARY KEY (id);


--
-- Name: calendar_events calendar_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (id);


--
-- Name: financial_items financial_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_items
    ADD CONSTRAINT financial_items_pkey PRIMARY KEY (id);


--
-- Name: financial_transactions financial_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_transactions
    ADD CONSTRAINT financial_transactions_pkey PRIMARY KEY (id);


--
-- Name: habit_logs habit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habit_logs
    ADD CONSTRAINT habit_logs_pkey PRIMARY KEY (id);


--
-- Name: habits habits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habits
    ADD CONSTRAINT habits_pkey PRIMARY KEY (id);


--
-- Name: lists lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_pkey PRIMARY KEY (id);


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- Name: notification_logs notification_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_pkey PRIMARY KEY (id);


--
-- Name: passkeys passkeys_credential_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_credential_id_key UNIQUE (credential_id);


--
-- Name: passkeys passkeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tags tags_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_user_id_name_key UNIQUE (user_id, name);


--
-- Name: task_embeddings task_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_embeddings
    ADD CONSTRAINT task_embeddings_pkey PRIMARY KEY (id);


--
-- Name: task_embeddings task_embeddings_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_embeddings
    ADD CONSTRAINT task_embeddings_task_id_key UNIQUE (task_id);


--
-- Name: task_links task_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_pkey PRIMARY KEY (id);


--
-- Name: task_shares task_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_pkey PRIMARY KEY (id);


--
-- Name: task_tags task_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_tags
    ADD CONSTRAINT task_tags_pkey PRIMARY KEY (task_id, tag_id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: team_invites team_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_pkey PRIMARY KEY (id);


--
-- Name: team_invites team_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_token_key UNIQUE (token);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: team_projects team_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_projects
    ADD CONSTRAINT team_projects_pkey PRIMARY KEY (id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: token_blacklist token_blacklist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_blacklist
    ADD CONSTRAINT token_blacklist_pkey PRIMARY KEY (id);


--
-- Name: board_sections uq_board_sections_user_kind_status; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_sections
    ADD CONSTRAINT uq_board_sections_user_kind_status UNIQUE (user_id, kind, status);


--
-- Name: team_members uq_team_member; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT uq_team_member UNIQUE (team_id, user_id);


--
-- Name: user_preferences uq_user_preferences_user_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT uq_user_preferences_user_key UNIQUE (user_id, key);


--
-- Name: watchlist_items uq_watchlist_items_user_tmdb; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist_items
    ADD CONSTRAINT uq_watchlist_items_user_tmdb UNIQUE (user_id, tmdb_id);


--
-- Name: user_notification_prefs user_notification_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_prefs
    ADD CONSTRAINT user_notification_prefs_pkey PRIMARY KEY (user_id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_tokens user_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_tokens
    ADD CONSTRAINT user_tokens_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: watchlist_items watchlist_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist_items
    ADD CONSTRAINT watchlist_items_pkey PRIMARY KEY (id);


--
-- Name: idx_notes_user_import_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_user_import_batch ON public.notes USING btree (user_id, import_batch_id);


--
-- Name: idx_tasks_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_parent ON public.tasks USING btree (parent_task_id);


--
-- Name: idx_tasks_parent_start_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_parent_start_date ON public.tasks USING btree (parent_task_id, start_date);


--
-- Name: idx_tasks_user_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_user_archived ON public.tasks USING btree (user_id, is_archived);


--
-- Name: idx_tasks_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_user_created ON public.tasks USING btree (user_id, created_at);


--
-- Name: idx_tasks_user_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_user_deleted ON public.tasks USING btree (user_id, deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_tasks_user_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_user_due_date ON public.tasks USING btree (user_id, due_date);


--
-- Name: idx_tasks_user_import_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_user_import_batch ON public.tasks USING btree (user_id, import_batch_id);


--
-- Name: idx_tasks_user_start_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_user_start_date ON public.tasks USING btree (user_id, start_date);


--
-- Name: idx_tasks_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_user_status ON public.tasks USING btree (user_id, status);


--
-- Name: ix_ai_cache_cache_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_cache_cache_key ON public.ai_cache USING btree (cache_key);


--
-- Name: ix_ai_cache_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_cache_expires_at ON public.ai_cache USING btree (expires_at);


--
-- Name: ix_ai_conversations_user_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_conversations_user_session ON public.ai_conversations USING btree (user_id, session_id, created_at);


--
-- Name: ix_ai_memories_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_memories_hnsw ON public.ai_memories USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: ix_ai_memories_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_memories_user_active ON public.ai_memories USING btree (user_id, is_active);


--
-- Name: ix_ai_sessions_user_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_sessions_user_session ON public.ai_sessions USING btree (user_id, session_id);


--
-- Name: ix_ai_usage_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_usage_month ON public.ai_usage USING btree (month);


--
-- Name: ix_ai_usage_user_provider_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_usage_user_provider_month ON public.ai_usage USING btree (user_id, provider, month);


--
-- Name: ix_analytics_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_analytics_events_created_at ON public.analytics_events USING btree (created_at);


--
-- Name: ix_analytics_events_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_analytics_events_event ON public.analytics_events USING btree (event);


--
-- Name: ix_analytics_events_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_analytics_events_user_id ON public.analytics_events USING btree (user_id);


--
-- Name: ix_api_tokens_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_api_tokens_hash ON public.api_tokens USING btree (token_hash);


--
-- Name: ix_api_tokens_user_revoked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_api_tokens_user_revoked ON public.api_tokens USING btree (user_id, revoked_at);


--
-- Name: ix_board_sections_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_board_sections_list ON public.board_sections USING btree (list_id);


--
-- Name: ix_calendar_events_user_google_cal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_calendar_events_user_google_cal ON public.calendar_events USING btree (user_id, google_event_id, calendar_id);


--
-- Name: ix_financial_items_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_financial_items_user_created ON public.financial_items USING btree (user_id, created_at);


--
-- Name: ix_financial_transactions_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_financial_transactions_item ON public.financial_transactions USING btree (item_id);


--
-- Name: ix_financial_transactions_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_financial_transactions_user_date ON public.financial_transactions USING btree (user_id, date);


--
-- Name: ix_habit_logs_habit_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_habit_logs_habit_date ON public.habit_logs USING btree (habit_id, completed_at);


--
-- Name: ix_habits_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_habits_user ON public.habits USING btree (user_id);


--
-- Name: ix_lists_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_lists_user ON public.lists USING btree (user_id);


--
-- Name: ix_notes_user_sort_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notes_user_sort_updated ON public.notes USING btree (user_id, sort, updated_at);


--
-- Name: ix_notification_logs_kind_sent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notification_logs_kind_sent ON public.notification_logs USING btree (kind, sent_at);


--
-- Name: ix_notification_logs_user_task_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notification_logs_user_task_kind ON public.notification_logs USING btree (user_id, task_id, kind);


--
-- Name: ix_passkeys_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_passkeys_user_id ON public.passkeys USING btree (user_id);


--
-- Name: ix_push_subscriptions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_push_subscriptions_user ON public.push_subscriptions USING btree (user_id);


--
-- Name: ix_task_embeddings_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_task_embeddings_hnsw ON public.task_embeddings USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: ix_task_links_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_task_links_source ON public.task_links USING btree (source_task_id);


--
-- Name: ix_task_links_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_task_links_target ON public.task_links USING btree (target_task_id);


--
-- Name: ix_task_links_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_task_links_user ON public.task_links USING btree (user_id);


--
-- Name: ix_task_shares_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_task_shares_task ON public.task_shares USING btree (task_id);


--
-- Name: ix_task_shares_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_task_shares_team ON public.task_shares USING btree (team_id);


--
-- Name: ix_tasks_board_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_board_section ON public.tasks USING btree (user_id, board_section_id, board_order);


--
-- Name: ix_tasks_desc_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_desc_trgm ON public.tasks USING gin (lower(COALESCE(description, ''::text)) public.gin_trgm_ops);


--
-- Name: ix_tasks_due_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_due_date_active ON public.tasks USING btree (due_date) WHERE (deleted_at IS NULL);


--
-- Name: ix_tasks_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_list ON public.tasks USING btree (list_id);


--
-- Name: ix_tasks_recurring_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_recurring_active ON public.tasks USING btree (user_id, recurrence_last_expanded_at) WHERE ((recurrence_rule IS NOT NULL) AND (deleted_at IS NULL) AND (status <> ALL (ARRAY['done'::public.task_status, 'cancelled'::public.task_status])));


--
-- Name: ix_tasks_title_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_title_trgm ON public.tasks USING gin (lower((title)::text) public.gin_trgm_ops);


--
-- Name: ix_tasks_user_active_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_user_active_created ON public.tasks USING btree (user_id, created_at) WHERE (deleted_at IS NULL);


--
-- Name: ix_tasks_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_user_created ON public.tasks USING btree (user_id, created_at);


--
-- Name: ix_tasks_user_recurring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks_user_recurring ON public.tasks USING btree (user_id) WHERE (recurrence_rule IS NOT NULL);


--
-- Name: ix_team_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_team_members_user ON public.team_members USING btree (user_id);


--
-- Name: ix_token_blacklist_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_token_blacklist_expires ON public.token_blacklist USING btree (expires_at);


--
-- Name: ix_token_blacklist_jti; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_token_blacklist_jti ON public.token_blacklist USING btree (jti);


--
-- Name: ix_user_tokens_user_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_tokens_user_provider ON public.user_tokens USING btree (user_id, provider);


--
-- Name: ix_watchlist_items_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_watchlist_items_user_created ON public.watchlist_items USING btree (user_id, created_at);

CREATE INDEX ix_account_deletions_email_hash ON public.account_deletions USING btree (email_hash);

CREATE INDEX ix_account_deletions_user_id ON public.account_deletions USING btree (user_id);


--
-- Name: ai_cache ai_cache_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cache
    ADD CONSTRAINT ai_cache_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_conversations ai_conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_memories ai_memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_memories
    ADD CONSTRAINT ai_memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_sessions ai_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_sessions
    ADD CONSTRAINT ai_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_usage ai_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: analytics_events analytics_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: api_tokens api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: board_sections board_sections_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_sections
    ADD CONSTRAINT board_sections_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE CASCADE;


--
-- Name: board_sections board_sections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_sections
    ADD CONSTRAINT board_sections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: calendar_events calendar_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: financial_items financial_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_items
    ADD CONSTRAINT financial_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: financial_transactions financial_transactions_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_transactions
    ADD CONSTRAINT financial_transactions_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.financial_items(id) ON DELETE SET NULL;


--
-- Name: financial_transactions financial_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_transactions
    ADD CONSTRAINT financial_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: habit_logs habit_logs_habit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habit_logs
    ADD CONSTRAINT habit_logs_habit_id_fkey FOREIGN KEY (habit_id) REFERENCES public.habits(id) ON DELETE CASCADE;


--
-- Name: habit_logs habit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habit_logs
    ADD CONSTRAINT habit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: habits habits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habits
    ADD CONSTRAINT habits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: lists lists_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notes notes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_logs notification_logs_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: notification_logs notification_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: passkeys passkeys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tags tags_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_embeddings task_embeddings_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_embeddings
    ADD CONSTRAINT task_embeddings_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_links task_links_source_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_source_task_id_fkey FOREIGN KEY (source_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_links task_links_target_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_target_task_id_fkey FOREIGN KEY (target_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_links task_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_shares task_shares_shared_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_shared_by_fkey FOREIGN KEY (shared_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_shares task_shares_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_shares task_shares_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: task_tags task_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_tags
    ADD CONSTRAINT task_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: task_tags task_tags_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_tags
    ADD CONSTRAINT task_tags_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_board_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_board_section_id_fkey FOREIGN KEY (board_section_id) REFERENCES public.board_sections(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_parent_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_parent_task_id_fkey FOREIGN KEY (parent_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_invites team_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_invites team_invites_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_projects team_projects_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_projects
    ADD CONSTRAINT team_projects_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: teams teams_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_notification_prefs user_notification_prefs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_prefs
    ADD CONSTRAINT user_notification_prefs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_tokens user_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_tokens
    ADD CONSTRAINT user_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: watchlist_items watchlist_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist_items
    ADD CONSTRAINT watchlist_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_memories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_memories ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: analytics_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: api_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: board_sections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.board_sections ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

--
-- Name: financial_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.financial_items ENABLE ROW LEVEL SECURITY;

--
-- Name: financial_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.financial_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: habit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.habit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: habits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.habits ENABLE ROW LEVEL SECURITY;

--
-- Name: lists; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;

--
-- Name: notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: passkeys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.passkeys ENABLE ROW LEVEL SECURITY;

--
-- Name: push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

--
-- Name: task_embeddings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_embeddings ENABLE ROW LEVEL SECURITY;

--
-- Name: task_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_links ENABLE ROW LEVEL SECURITY;

--
-- Name: task_shares; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: task_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: team_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: task_shares team_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY team_isolation ON public.task_shares USING (((shared_by = public.rls_user_id()) OR public.is_team_member(team_id, public.rls_user_id()))) WITH CHECK (((shared_by = public.rls_user_id()) OR public.is_team_member(team_id, public.rls_user_id())));


--
-- Name: team_invites team_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY team_isolation ON public.team_invites USING (((invited_by = public.rls_user_id()) OR public.is_team_member(team_id, public.rls_user_id()) OR (lower((email)::text) = lower(public.rls_user_email())))) WITH CHECK (((invited_by = public.rls_user_id()) OR public.is_team_member(team_id, public.rls_user_id()) OR (lower((email)::text) = lower(public.rls_user_email()))));


--
-- Name: team_members team_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY team_isolation ON public.team_members USING (((user_id = public.rls_user_id()) OR public.is_team_member(team_id, public.rls_user_id()))) WITH CHECK (((user_id = public.rls_user_id()) OR public.is_team_member(team_id, public.rls_user_id())));


--
-- Name: team_projects team_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY team_isolation ON public.team_projects USING (public.is_team_member(team_id, public.rls_user_id())) WITH CHECK (public.is_team_member(team_id, public.rls_user_id()));


--
-- Name: teams team_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY team_isolation ON public.teams USING (((owner_id = public.rls_user_id()) OR public.is_team_member(id, public.rls_user_id()))) WITH CHECK (((owner_id = public.rls_user_id()) OR public.is_team_member(id, public.rls_user_id())));


--
-- Name: team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: team_projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_projects ENABLE ROW LEVEL SECURITY;

--
-- Name: teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_cache user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.ai_cache USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: ai_memories user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.ai_memories USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: ai_usage user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.ai_usage USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: analytics_events user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.analytics_events USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: api_tokens user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.api_tokens USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: board_sections user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.board_sections USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: financial_items user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.financial_items USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: financial_transactions user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.financial_transactions USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: lists user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.lists USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: notes user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.notes USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: notification_logs user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.notification_logs USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: passkeys user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.passkeys USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: push_subscriptions user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.push_subscriptions USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: tags user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.tags USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: task_tags user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.task_tags USING ((task_id IN ( SELECT tasks.id
   FROM public.tasks
  WHERE (tasks.user_id = public.rls_user_id())))) WITH CHECK ((task_id IN ( SELECT tasks.id
   FROM public.tasks
  WHERE (tasks.user_id = public.rls_user_id()))));


--
-- Name: tasks user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.tasks USING (((user_id = public.rls_user_id()) OR (EXISTS ( SELECT 1
   FROM public.task_shares ts
  WHERE ((ts.task_id = tasks.id) AND public.is_team_member(ts.team_id, public.rls_user_id())))))) WITH CHECK (((user_id = public.rls_user_id()) OR (EXISTS ( SELECT 1
   FROM public.task_shares ts2
  WHERE ((ts2.task_id = tasks.id) AND public.is_team_member(ts2.team_id, public.rls_user_id()))))));


--
-- Name: user_notification_prefs user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.user_notification_prefs USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: user_preferences user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.user_preferences USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: watchlist_items user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_isolation ON public.watchlist_items USING ((user_id = public.rls_user_id())) WITH CHECK ((user_id = public.rls_user_id()));


--
-- Name: user_notification_prefs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_notification_prefs ENABLE ROW LEVEL SECURITY;

--
-- Name: user_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: user_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--
-- NOTE: intentionally NOT row-level-secured. OAuth tokens are Fernet-encrypted
-- at rest and every query scopes by user_id, while core background loops (the
-- Google Calendar pull) read tokens across users on the app pool with no RLS
-- context. A policy here would silently return zero rows and break token
-- refresh/store (and a FORCE with no policy rejects every write).

--
-- Name: watchlist_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.watchlist_items ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--
