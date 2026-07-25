# AGENTS.md — Prysm Note

## Project Overview
Prysm Note is an AI-powered task management application with a 3-pane UI (sidebar, timeline, AI chat). Built as a folder-based monorepo. **Open-core model**: the `ee/` directory contains proprietary enterprise features not shipped in the community release.

## Enterprise Edition (EE)

All **business**, **commercial**, **premium**, **enterprise**, **paid**, **pro**, or **team** features
MUST be placed under the `ee/` directory. See `ee/EE_AGENTS.md` for details on
integration patterns and directory structure.

## Architecture

```
prysm-note/
├── apps/
│   ├── frontend/        # Next.js 14 App Router + Tailwind CSS
│   └── backend/         # FastAPI + SQLAlchemy (async) + PostgreSQL/pgvector
├── ee/                  # Enterprise Edition (proprietary, not in community release)
│   ├── apps/
│   │   ├── backend/ee/  # EE backend package
│   │   └── frontend/ee/ # EE frontend package
│   └── EE_AGENTS.md     # EE coding instructions for agents
├── docker/              # Dockerfiles + DB init scripts
├── docker-compose.yml
└── turbo.json           # Turborepo pipeline
```

## Quick Start

### Docker (recommended)
```bash
cp .env.example .env
docker-compose up
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
| `docker-compose up` | root | Start all services |

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
