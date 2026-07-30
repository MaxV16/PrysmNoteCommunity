# AGENTS.md — Prysm Note

## Git Workflow

After every meaningful set of file changes, you MUST:
1. Stage all changed files: `git add <files>`
2. Create a commit with a conventional commit message: `git commit -m "type(scope): description"`
3. Push immediately: `git push`

Batch related changes into a single commit. Do not create one commit per file or per micro-edit.

**CRITICAL: Do NOT start, run, or restart any Docker containers, dev servers, databases, or localhost processes.** The user runs the app exclusively via their own start.bat script.

Allowed build-only commands that self-terminate:
- `npm run build` (frontend) — verify compilation, then stop
- `npm run test` (frontend) — run tests, then stop  
- `pytest` (backend) — run tests, then stop

If Docker containers are running when you start working, kill them immediately with `docker compose down`. Never leave processes running after your work is done. Never use `docker compose up`, `npm run dev`, `uvicorn`, `next dev`, or any other long-running command.

## Project Overview
Prysm Note is an AI-powered task management application with a 3-pane UI (sidebar, timeline, AI chat). Built as a folder-based monorepo. **Open-core model**: the `ee/` directory contains proprietary enterprise features not shipped in the community release.

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

## Docker & Build Critical Context

### Docker Desktop for Windows Path Issue
On Docker Desktop for Windows, `process.cwd()` and `__dirname` inside containers resolve to Windows host paths (e.g. `C:\Users\...`) rather than container paths (e.g. `/app/`). This breaks any build-time path resolution that relies on these globals.

**ALWAYS use the `src/ee/` directory approach for EE file access:**
- In `docker/frontend.Dockerfile`: `COPY ee/apps/frontend/ee ./src/ee/`
- In source code: `import from "@/ee/components/..."` (uses the `@/*` → `./src/*` alias)
- The `next.config.ts` webpack alias `@/ee` falls back to `../../ee/apps/frontend/ee` for local dev
- A local junction from `apps/frontend/src/ee/` → `../../ee/apps/frontend/ee/` may be needed for local dev
- Do NOT rely on tsconfig `paths` for `@ee/*` — it breaks in Docker because the path resolves to host absolute paths

### Docker Compose Dev Mode (Volume Mounts)
The `docker-compose.yml` mounts `./apps/frontend:/app` in dev mode, OVERRIDING the Dockerfile build output. The container runs `npx next dev`, so changes to source files take effect immediately.

**EE volume mount:** `./ee/apps/frontend/ee:/app/ee` (NOT `./ee:/app/ee` which puts files at the wrong path)

### API Proxy Setup
`NEXT_PUBLIC_API_URL=/api` — browsers use same-origin requests. Next.js rewrites proxy `/api/*` to `http://backend:8000/api/*` via the internal Docker network. This avoids CORS and host-port mapping issues.

**`next.config.ts` rewrites:**
```ts
async rewrites() {
  return [
    { source: "/api/:path*", destination: `${process.env.API_PROXY || "http://backend:8000"}/api/:path*" },
  ];
}
```
Set `API_PROXY=http://backend:8000` in docker-compose frontend environment.

### Rebuild & Restart Commands
```bash
# Full clean rebuild (required when Dockerfile, package.json, or next.config.ts change)
docker compose build --no-cache frontend
docker compose up -d

# Restart containers (when only source files changed via volume mounts)
docker compose restart frontend
```

### Known Docker Build Failures
1. **Module not found: `@ee/components/*`** — EE files not copied to `src/ee/` in Dockerfile, or volume mount at wrong path in dev mode. Fix: `COPY ee/apps/frontend/ee ./src/ee/` and import as `@/ee/...`
2. **`@ee` alias resolves to host path** — tsconfig `paths` for `@ee/*` cause this. Fix: use only webpack alias in `next.config.ts`, not tsconfig paths
3. **Build succeeds locally but fails in Docker** — `process.cwd()`/`__dirname` path resolution difference. Fix: use `fs.existsSync` to probe multiple locations in the webpack alias

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
| `docker compose down` | root | Stop all containers |

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
