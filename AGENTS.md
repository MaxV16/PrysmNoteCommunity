# AGENTS.md — Prysm Note

## Prerequisites

The GitHub CLI (`gh`) is required for commit/push verification. If not installed:
```bash
brew install gh
gh auth login
```

## Web Search (Always On)

Use the built-in `websearch` / `webfetch` tools (no API key needed) whenever you need
current, up-to-date, or external web information (latest docs, releases, bug reports,
package versions, conventions, Stack Overflow, Autonoma usage, etc.) instead of guessing.

- **Trigger it automatically**: prefer `websearch` before answering anything that is stale
  or uncertain, or where accuracy matters. Do not wait to be asked.
- **Part of the Autonoma loop too**: when debugging an Autonoma failure, look up relevant
  docs/schemas with `websearch` and apply the findings alongside the code fix.
- **Search then use**: pass the returned snippets/titles/URLs as source material in your
  answer, phrased as search findings rather than personal knowledge.

### Web Search Privacy & Secret-Handling (REQUIRED)

Never leak secrets, credentials, or sensitive values into a web search. Treat every DuckDuckGo query as if it
will be sent publicly to a third-party service. Enforce these rules on **every** search query:

- **NEVER include in any query:**
  - API keys, tokens, secrets, passwords, or credentials (e.g. `OPENAI_API_KEY`, `JWT_SECRET_KEY`,
    `ENCRYPTION_KEY`, `sk-or-v1-...`, Bearer tokens).
  - Connection strings (e.g. `DATABASE_URL`) — especially with embedded usernames/passwords.
  - Internal hostnames, IPs, ports, or private project/file paths.
  - Customer/PII data or anything confidential.
- **Sanitize the query**: replace secrets/internal values with generic descriptions before searching.
  - Bad: `ddg_web_search "how to fix {MY_DASHBOARD_URL} + sk-or-v1-572a..."`
  - Good: `ddg_web_search "how to fix a 401 auth error on a Next.js app"`.
- If a search genuinely needs the context around a secret, paraphrase it in neutral terms so the value itself
  never leaves the machine.
- **Verify the query text** before sending: if a pasted command, snippet, or log line would expose a secret,
  redact it first, then search.
- When pasting docs, code, or error output into the conversation or search, check for embedded secrets and
  scrub them first.

This applies both to web search and to anything shared externally (commits, PRs, issues, Docker, logs).

## Git Workflow

After every meaningful set of file changes, you MUST:
1. Run normal build + tests, then the **Autonoma full app check** (`npm run test:e2e:full`)
   and fix any **confirmed** failures it reports (see "AI-Driven E2E Testing (Autonoma Loop)"
   below).
2. Stage all changed files: `git add <files>`
3. Create a commit with a conventional commit message: `git commit -m "type(scope): description"`
4. Push immediately: `git push`
5. **Wait for CI and sync workflows to complete, then check for failures:**
   ```bash
   gh run list --workflow=CI --limit 1 --json conclusion,databaseId,displayTitle,url
   gh run list --workflow="Sync to Community Edition" --limit 1 --json conclusion,databaseId,displayTitle,url
   ```
6. If any workflow failed, inspect the error with `gh run view <databaseId> --log | grep -E "Error|error|FAILED|exit code"` and fix the root cause, then commit and push the fix.
7. Repeat steps 5-6 until both workflows pass.

Batch related changes into a single commit. Do not create one commit per file or per micro-edit.

**CRITICAL: After every meaningful change, rebuild/recompile and update Docker so changes appear on `localhost`.** The recommended workflow is:

```bash
# 1) Verify the build compiles and run the test suites (all self-terminating):
npm run build                              # compile the frontend
npm run test                               # run frontend tests
cd apps/backend && pytest -v && cd ../..   # run backend tests

# 2) Rebuild changed Docker images (SAFE: never uses -v, never touches volumes):
docker compose up -d --build frontend backend

# 3) Restart so volume-mounted source is picked up / available immediately:
docker compose restart frontend backend
```

- Plain source-file edits under `apps/frontend`/`apps/backend` are hot-reloaded via volume mounts
  (`npx next dev` and `uvicorn --reload`), so `docker compose restart frontend backend` is usually
  enough to see changes. A full `docker compose up -d --build frontend backend` is only required
  when the Dockerfile, `package.json`, `next.config.ts`, or other build inputs change.
- Do not leave long-running processes hanging after your work: run the build/tests, update Docker,
  then stop. Never use `npm run dev`, `uvicorn`, or `next dev` directly — let Docker run them.

**BANNED — DESTRUCTIVE / DATA-LOSS: NEVER RUN THESE.** They permanently delete the database and all user data:
- `docker compose down -v` / `--volumes`
- `docker volume rm` (any volume, including `prysmnotedev_postgres_data`)
- `docker compose rm -v`, `docker system prune -a --volumes`, or any `-v`/`--volumes` flag with a database container

This is production data. The exact incident that caused data loss was `docker compose down -v` wiping the `prysmnotedev_postgres_data` volume.

If containers are running and you need to stop them, **stop gracefully WITHOUT removing volumes** so no data is lost:
```bash
# Stop containers (keeps all volumes and data intact):
docker compose stop          # or: docker compose down  (no -v!)
# To bring them back up afterwards:
docker compose up -d
```
- Never add `-v` (volumes) to any down/stop/rm command.
- Do not interrupt containers preemptively. Only stop them if necessary to pick up changes or the user explicitly asks.
- If a container MUST be removed (e.g. to rebuild), it is still safe to run `docker compose down` (stops and removes containers/networks) — the named `*_postgres_data` volume is persisted unless `-v` is used.

Never leave a long-running foreground process hanging after your work is done (run `docker compose up` and other long-running commands only in the detached/update forms described above, and stop containers gracefully when finished).

## Project Overview

## Architecture

```
prysm-note/
├── apps/
│   ├── frontend/        # Next.js 14 App Router + Tailwind CSS
│   └── backend/         # FastAPI + SQLAlchemy (async) + PostgreSQL/pgvector
├── docker/              # Dockerfiles + DB init scripts
├── docker-compose.yml
└── turbo.json           # Turborepo pipeline
```

## Quick Start

### Docker (recommended)
```bash
cp .env.example .env
docker compose up
# Open http://localhost:3000
```

### Local (requires PostgreSQL 16 + pgvector on localhost:5432)
```bash
# One-time setup
pip install -e apps/backend
npm install

# Terminal 1 — Backend
cd apps/backend && uvicorn app.main:app --reload --port 8000

# Terminal 2 — Frontend
cd apps/frontend && npm run dev
```

## Common Commands

| Command | Directory | Description |
|---------|-----------|-------------|
| `npm run dev` | root | Start frontend dev server via Turborepo |
| `npm run build` | root | Build frontend via Turborepo |
| `npm run lint` | root | Lint frontend via Turborepo |
| `uvicorn app.main:app --reload` | apps/backend | Run backend dev server |
| `alembic upgrade head` | apps/backend | Run DB migrations |
| `docker compose up` | root | Start all services |
| `docker compose build --no-cache frontend` | root | Full frontend rebuild |
| `docker compose down` | root | Stop all containers (SAFE: keeps volumes/data. NEVER add `-v`) |

## Environment Variables

See `.env.example` for the full list. Key variables:
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET_KEY` — 64-char random string for JWT signing
- `ENCRYPTION_KEY` — 44-char Fernet key for API key encryption
- `NEXT_PUBLIC_API_URL` — Backend API URL (default `http://localhost:8000/api`)

## Database

- PostgreSQL 16 with `pgvector` extension for AI embeddings
- Alembic migrations in `apps/backend/alembic/`
- All tables have RLS (Row-Level Security) policies keyed on `app.user_id` session variable
- **Backup your data:** the `prysmnotedev_postgres_data` volume contains ALL persisted data. Routinely back it up so it can never be lost:
  ```bash
  docker exec prysmnotedev-postgres-1 pg_dump -U prysm -d prysm_note > backups/prysm_note_$(date +%Y%m%d).sql
  ```
  To restore: `docker exec -i prysmnotedev-postgres-1 psql -U prysm -d prysm_note < backups/prysm_note_<date>.sql`
- **Date columns** (`start_date`, `due_date`, `recurrence_end_date`) are `Mapped[date | None]` in SQLAlchemy models. **ALWAYS** convert string dates to `datetime.date` objects using `date.fromisoformat()` before assignment. Never pass raw strings — asyncpg requires `date` objects and will throw `'str' object has no attribute 'toordinal'`. See `app/services/task_service.py::_parse_date()`.

## Key Backend Patterns

### LLM Adapter
All LLM providers implement the `LLMClient` abstract base class in `app/llm/base.py`. New providers register via the `@register_provider(name)` decorator. See `app/llm/openai_client.py` for reference.

### Auth
- JWT access tokens (15 min) + refresh tokens (7 days)
- `bcrypt` password hashing
- `get_current_user` dependency extracts user from Bearer token

### RLS
- `app/utils/rls.py::set_rls_user_id()` sets PostgreSQL session variable
- Called in `dependencies.py::get_current_user()`

## Frontend Patterns

### State Management
- Zustand store in `src/stores/app-store.ts`
- Auth state via React Context in `src/lib/auth-context.tsx`

### Data Fetching
- Custom hooks in `src/hooks/` (useTasks, useProjects, useTags, useAIChat, useTimeline, useApiKeys)
- API client in `src/lib/api.ts` with JWT auto-attachment

### Component Structure
- `src/components/layout/` — ThreePaneLayout, TimelineView
- `src/components/sidebar/` — SidebarLeft, NavSection, ProjectList, FilterBar, TagList
- `src/components/timeline/` — TimelineHeader, TimelineGrid, TimelineLane, TaskBar
- `src/components/ai/` — ChatPanel, ChatMessage, ChatInput
- `src/components/tasks/` — TaskDetail, TaskForm, TaskChecklist, TaskLinks
- `src/components/ui/` — Button, Input, Modal, Dropdown, Badge, Spinner

## Testing

### Frontend (Vitest + React Testing Library)
```bash
cd apps/frontend
npm test             # single run (42 tests: store, api, auth-context, utils)
npm run test:watch   # watch mode
```

### Backend (pytest + pytest-asyncio + httpx)
```bash
cd apps/backend
pip install -e .[test]
pytest -v            # 80+ tests: auth, tasks, projects, tags, search, AI service, task links
```

## API Keys (Encryption)
User-provided LLM API keys (OpenAI, Gemini, DeepSeek) are encrypted at rest using Fernet (symmetric encryption from the `cryptography` library) before being stored in the `encrypted_key` BYTEA column of `api_keys` table. The `ENCRYPTION_KEY` in `.env` must be a 44-character base64-encoded Fernet key. Decryption happens in-memory only when the key is needed for an API call. See `app/utils/encryption.py`.

## AI-Driven E2E Testing (Autonoma Loop)

Autonoma (cloned at `~/Downloads/autonoma`) is an AI agent that drives a real
headless browser against the running app, screenshots/videos every step, and
reports what failed — screenshot + video + a written reason. **The intended loop:
after ANY change to Prysm Note UI/backend, run Autonoma, read its failure report,
and fix confirmed failures — then re-run until clean.**

### Run it (from repo root)
```bash
npm run test:e2e           # quick core check (5 checks)
npm run test:e2e:full      # FULL app check (10 checks) — before settling on a change
npm run test:e2e:rebuild   # rebuild Prysm Note Docker first, then core check
```
Entry point: `autonoma/run-tests.sh` (handles PRYSM Note up, Autonoma infra up,
fresh session-cookie auth, OpenRouter-driven agent, artifact saving).

### Test cases
- `autonoma-tests/prysmnote-core.tc.md` — core: workspace, new task on timeline,
  Ctrl+F search, settings toggles, AI chat.
- `autonoma-tests/prysmnote-full.tc.md` — full: adds view modes, task edit,
  project rail + tags, theme, sticky notes.

### After a run
- Full logs: `autonoma-artifacts/<run>/run.log`
- Screenshots + video: `~/Downloads/autonoma/apps/engine-web/artifacts/<latest>`
- The agent prints a per-check PASS/FAIL list. Read the FAIL reasons, verify each
  against the real app (direct Playwright or the API — see below), fix confirmed
  bugs in Prysm Note, then re-run.

### Mandatory rule: verify before fixing — multi-channel, never single-source

Autonoma uses screenshot-coordinate clicking and an LLM-driven browser, so it
sometimes reports false positives (it clicks the wrong `+ New`, clicks near a
button, misread a view/tab, or blames a real bug for its own navigation loop).
Treat **any single Autonoma report as a hypothesis, not a fact.** Never change
code based on Autonoma alone.

Before editing Prysm Note for a reported failure, confirm the real behavior
through **at least two independent, reproducible channels**, and record the
evidence in the commit/PR:

1. **API  — deterministic truth.** Hit the real endpoints (`/api/...`) directly
   (curl or a script) and assert on the actual response body/status. E.g. create
   a task and verify it 200s and returns the task; GET it back.
2. **Headless DOM assertions — deterministic UI truth.** Drive a real headless
   browser (Playwright) with explicit, coordinate-free assertions (`getByRole`,
   `getByText`, `expect(...).toBeVisible()`), not screenshot clicking. If the
   agent could not find something, assert it from the DOM directly.
3. **Code inspection — root-cause truth.** Read the component/handler that is
   claimed broken and confirm the code path actually produces the reported
   symptom (or cannot).

A confirmed bug = the symptom reproduces through **≥2 of the 3 channels above**
(e.g., the API returns the wrong thing AND a headless `toBeVisible` assertion
fails for a concrete reason). If a channel contradicts the report (e.g., the API
returns the task but the agent says it "disappeared"), the report is a false
positive — do not fix.

When you fix a confirmed bug, add or update an automated regression test that
fails without the fix and passes with it, so the loop does not re-report the
same false positive.

### Using the smoke tests instead of (or before) Autonoma
Run the deterministic smoke checks before deciding anything needs a full Autonoma
pass:

```bash
npm run smoke:api        # direct API assertions (signup/login → task CRUD → round-trip)
npm run smoke:ui         # headless Playwright DOM assertions (login → new task → visible on today)
EXECUTABLE_PATH=... npm run smoke:ui   # point at a specific local Chromium if needed
# smoke:ui reuses the Chromium already cached on this machine (shared with
# Autonoma); set EXECUTABLE_PATH to a Playwright-managed browser to use it.
```

`npm run smoke:ui` uses coordinate-free selectors, so it is the primary source of
truth for "did the task appear". Prefer a green `smoke:api` + `smoke:ui` over a
fast re-run of Autonoma when you are verifying UI/task-creation behavior.

### Web search
Use `websearch` freely to look up Autonoma usage, API details, or anything
unclear, then apply the findings.

### Model/config notes
- Autonoma uses the user's OpenRouter key (`.env` → `OPENROUTER_API_KEY`),
  cheapest models: `google/gemini-3-flash-preview` (vision, forced tool calling)
  + `openai/gpt-oss-120b` (text) + `mistralai/ministral-8b-2512` (fast). No
  Gemini/Groq keys needed.
- Requires Node >= 24 + pnpm 11 (installed keg-only via `node@24`) and Autonoma
  infra (postgres :5433, redis :6380, temporal :7233) via
  `docker compose -f ~/Downloads/autonoma/docker-compose.coexist.yaml up -d` —
  all isolated from Prysm Note's own containers/data.

## Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS, Zustand, @dnd-kit |
| Backend | FastAPI, SQLAlchemy 2 (async), Pydantic v2 |
| Database | PostgreSQL 16, pgvector |
| AI/LLM | OpenAI, Google Gemini, DeepSeek (adapter pattern) |
| Auth | JWT, bcrypt |
| Calendar | Google Calendar API |
| Infrastructure | Docker, Docker Compose, Turborepo |
