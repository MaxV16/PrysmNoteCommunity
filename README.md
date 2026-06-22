# Prysm Note 🔮

AI-powered task management with a 3-pane interface (sidebar, timeline, AI chat). Built as a folder-based monorepo.

## Quick Start

### Option 1: Docker (recommended)

```bash
cp .env.example .env
# Edit .env with your secrets
docker-compose up
```

### Option 2: Local Development

**Prerequisites:** Node.js 20+, Python 3.11+, PostgreSQL 16 with pgvector

```bash
# 1. Setup
npm run setup

# 2. Launch
npm run launch
```

### Option 3: Manual

**Backend:**
```bash
cd apps/backend
pip install -e .
uvicorn app.main:app --reload --port 8000
```

**Frontend:**
```bash
cd apps/frontend
npm install
npm run dev
```

Open http://localhost:3000

## Features

### Core
- **3-Pane UI**: Sidebar navigation | Timeline view | AI chat assistant
- **Task Management**: Full CRUD with drag-and-drop rescheduling
- **Timeline**: Gantt-style horizontal timeline with per-project lanes

### AI Assistant
- Multi-intent parsing ("Create a meeting next Thursday, recurring every 2 weeks")
- Smart deduplication checks before creating tasks
- Contextual subtask suggestions ("Break this down" button on broad tasks)
- Schedule conflict detection
- Cross-referencing and linking tasks across projects
- Provider routing: OpenAI, Google Gemini, DeepSeek
- Semantic search via pgvector embeddings

### Security
- JWT authentication (15-min access + 7-day refresh tokens)
- Row-Level Security (RLS) on all database tables
- API keys encrypted at rest (Fernet)
- Rate limiting on auth endpoints
- IP blocklist after 10 failed login attempts
- Input validation on all endpoints

### Themes
5 built-in themes:
- **Dark** (default) — #1e1e1e base
- **Light** — Clean white
- **Dracula** — Purple accents
- **Nord** — Arctic blues
- **Monokai** — Yellow/green accents

### Google Calendar Sync
- OAuth 2.0 integration
- Two-way sync (push tasks to calendar, pull events)
- Token storage with auto-refresh

## Environment Variables

Key variables in `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET_KEY` | Yes | 64-char random string for JWT |
| `ENCRYPTION_KEY` | Yes | 44-char Fernet key for API key encryption |
| `GOOGLE_CLIENT_ID` | No | Google Calendar OAuth |
| `GOOGLE_CLIENT_SECRET` | No | Google Calendar OAuth |
| `NEXT_PUBLIC_API_URL` | No | API URL (default: http://localhost:8000/api) |

Generate keys:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## Architecture

```
prysm-note/
├── apps/
│   ├── frontend/        # Next.js 14 App Router + Tailwind CSS
│   └── backend/         # FastAPI + SQLAlchemy (async) + PostgreSQL/pgvector
├── docker/              # Dockerfiles + DB init scripts
├── scripts/             # Launch & setup scripts
├── docker-compose.yml
└── turbo.json
```

### Database (11+ tables)
- users, projects, tasks, tags, task_tags, task_links
- api_keys (encrypted), task_embeddings (pgvector), ai_conversations
- calendar_events, user_tokens (OAuth storage)

All tables have RLS policies keyed on `app.user_id` session variable.

### LLM Adapter Pattern
All providers implement `LLMClient` ABC in `app/llm/base.py`. Register with `@register_provider(name)`.

## API Overview

| Endpoint | Description |
|----------|-------------|
| `POST /api/auth/register` | Create account |
| `POST /api/auth/login` | Sign in |
| `POST /api/auth/refresh` | Refresh JWT |
| `GET/POST/PATCH/DELETE /api/tasks` | Task CRUD |
| `GET/POST /api/tasks/{id}/subtasks` | Subtask management |
| `POST /api/tasks/expand-recurring` | Expand recurring tasks |
| `GET /api/projects` | List projects |
| `GET/POST/DELETE /api/tags` | Tag management |
| `POST/DELETE /api/tags/tasks/{id}` | Task-tag associations |
| `GET/POST/DELETE /api/task-links` | Task link management |
| `GET /api/search/?q=&mode=semantic` | Search with vector mode |
| `POST /api/ai/chat` | AI chat (non-streaming) |
| `POST /api/ai/chat/stream` | AI chat (SSE streaming) |
| `GET /api/ai/sessions` | List AI chat sessions |
| `POST /api/keys` | Save API key (encrypted) |
| `POST /api/calendar/sync` | Sync with Google Calendar |

## Common Commands

```bash
npm run dev       # Start frontend dev server
npm run build     # Build frontend
npm run setup     # One-time environment setup
npm run launch    # Build + start both frontend & backend
docker-compose up # Full stack with Docker
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 18, TypeScript, Tailwind CSS, Zustand, @dnd-kit |
| Backend | FastAPI, SQLAlchemy 2 (async), Pydantic v2, Alembic |
| Database | PostgreSQL 16, pgvector |
| AI/LLM | OpenAI, Google Gemini, DeepSeek (adapter pattern) |
| Auth | JWT (python-jose), bcrypt |
| Calendar | Google Calendar API |
| Infrastructure | Docker, Docker Compose, Turborepo |

## License

MIT License. See `LICENSE`.
