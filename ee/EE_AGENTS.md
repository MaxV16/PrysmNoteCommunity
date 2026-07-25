# EE_AGENTS.md — Prysm Note Enterprise Edition

## Enterprise Edition Directory

This `ee/` directory contains all proprietary, commercial, and business-tier features
for Prysm Note. These features are **not** included in the community open-source release.

## Directive for Agents

When asked to implement any **business**, **commercial**, **premium**, **enterprise**,
**paid**, **pro**, or **team** features, place all code inside this `ee/` directory
structure. Never add such features to the open-core codebase under `apps/`.

## Directory Structure

```
ee/
├── EE_AGENTS.md              # This file
├── apps/
│   ├── backend/
│   │   └── ee/               # Enterprise backend Python package
│   │       ├── __init__.py
│   │       ├── routers/      # EE-specific API routes
│   │       ├── models/       # EE database models
│   │       ├── services/     # EE business logic services
│   │       └── middleware/   # EE middleware (license checks, etc.)
│   └── frontend/
│       └── ee/               # Enterprise frontend package
│           ├── components/   # EE React components
│           ├── hooks/        # EE custom hooks
│           ├── stores/       # EE Zustand stores
│           ├── lib/          # EE utilities
│           └── pages/        # EE pages/routes
└── docker/                   # EE-specific Docker configs
```

## Integration Patterns

### Backend Integration
- EE FastAPI routers are mounted in `apps/backend/app/main.py` conditionally (behind
  feature-flag or license check), importing from `ee.apps.backend.ee.routers`.
- EE database models import base models from `apps/backend/app/models/`.
- EE services may extend or decorate core services via dependency injection.

### Frontend Integration
- EE components are lazy-loaded via Next.js dynamic imports, gated by feature flags.
- EE routes/pages are discovered and mounted at runtime based on license tier.
- Core components expose extension points (slots/hooks) that EE components fill.

## Strip During Community Sync

Everything in `ee/` is stripped by the CI sync workflow before pushing to
`PrysmNoteCommunity`. The community repo also gets an AGPL-3.0 license applied.
