#!/usr/bin/env bash
# Manual production deploy, the interim path while CircleCI and GitHub Actions are
# unavailable. Runs from the developer machine (macOS/Linux): it SSHes to the
# production VM, checks out the pushed commit, rebuilds the images there, and
# recreates only the frontend/backend containers. Postgres, Redis and nginx keep
# running, so the site stays up. This script NEVER passes -v and never removes a
# volume.
#
# Usage:
#   scripts/deploy-manual.sh [--skip-tests] [--skip-ui] [--yes]
#
# Preconditions:
#   - The commit you want live is pushed to origin/main (this deploys HEAD).
#   - SSH access to the VM via .deploy-ssh/prysmnote_deploy.
#
# Before the deploy it runs two local gates: the frontend unit suite and, unless
# --skip-ui is passed, the Playwright UI smoke against the LOCAL dev stack (where
# email verification is off, so the smoke can register and sign in; production
# cannot, it requires email verification). The UI smoke builds + starts the dev
# stack itself. After the deploy it confirms https://prysmnote.com/api/health
# reports the deployed commit and runs scripts/smoke-check.sh against production.

set -euo pipefail

SSH_KEY=".deploy-ssh/prysmnote_deploy"
VM_HOST="deploy@152.53.16.214"
HEALTH_URL="https://prysmnote.com/api/health"

RUN_TESTS=1
RUN_UI_SMOKE=1
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) RUN_TESTS=0 ;;
    --skip-ui) RUN_UI_SMOKE=0 ;;
    --yes|-y) ASSUME_YES=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short=12 HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty, commit first." >&2
  exit 1
fi

git fetch -q origin main
if [ "$SHA" != "$(git rev-parse origin/main)" ]; then
  echo "ERROR: HEAD ($SHORT) is not pushed to origin/main, push first." >&2
  exit 1
fi

echo "==> manual deploy of $SHORT"

# Fast local gate. The frontend unit suite is quick; the backend suite needs a
# Postgres and is slow, so run it yourself when the change touches the backend.
if [ "$RUN_TESTS" = "1" ]; then
  echo "==> frontend tests"
  ( cd apps/frontend && npm test )
fi

# Pre-deploy UI gate. The Playwright smoke registers a fresh user and walks the
# app, so it runs against the local dev stack (email verification is off there);
# production would reject the sign-in. This stands in for the missing CI UI job.
# Skip with --skip-ui. The dev stack is left running afterwards.
if [ "$RUN_UI_SMOKE" = "1" ]; then
  echo "==> pre-deploy UI smoke (local dev stack)"
  docker compose up -d --build backend frontend
  for _ in $(seq 1 60); do
    if curl -fsS http://localhost:8000/api/health >/dev/null 2>&1 \
       && curl -fsS http://localhost:3000 >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  BASE_URL=http://localhost:3000 npm run smoke:ui
fi

if [ "$ASSUME_YES" != "1" ]; then
  printf "Deploy %s to production? [y/N] " "$SHORT"
  read -r reply
  case "$reply" in y|Y) ;; *) echo "aborted"; exit 1 ;; esac
fi

echo "==> rebuilding images on the VM and recreating frontend/backend"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$VM_HOST" "SHA='$SHA' bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/prysm-note"
git fetch -q origin main
git checkout --force "$SHA"

OWNER="${IMAGE_OWNER:-maxv16}"
ENV_FILE=.env.prod
sed -i '/^GIT_SHA=/d' "$ENV_FILE" 2>/dev/null || true
printf 'GIT_SHA=%s\n' "$SHA" >> "$ENV_FILE"

docker build -f deploy/docker/backend-rust.prod.Dockerfile -t "ghcr.io/$OWNER/prysmnote-backend:latest" .
docker build -f deploy/docker/frontend.prod.Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=/api \
  --build-arg NEXT_PUBLIC_GIT_SHA="$SHA" \
  --build-arg NEXT_PUBLIC_CF_ANALYTICS_BEACON="${NEXT_PUBLIC_CF_ANALYTICS_BEACON:-}" \
  -t "ghcr.io/$OWNER/prysmnote-frontend:latest" .

docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d --wait
docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" exec -T backend \
  curl -fsS http://localhost:8000/api/health
REMOTE

echo "==> verifying the live version"
live="$(curl -fsS "$HEALTH_URL" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
echo "live version: ${live:-<none>}"
if [ "$live" != "$SHA" ]; then
  echo "ERROR: live version does not match $SHA (roll back with scripts/rollback.sh)" >&2
  exit 1
fi

echo "==> post-deploy smoke"
SMOKE_BASE_URL="https://prysmnote.com" bash scripts/smoke-check.sh || true

echo "==> done: $SHORT is live"
