#!/usr/bin/env bash
# test-community-stack.sh
#
# Boots the Community Edition stack (published or locally built images) and
# proves it actually works, not just that the containers start:
#   1. backend /api/health answers ok
#   2. the frontend serves /login (200)
#   3. signup, login, task create, task list round-trip through the real API
#   4. the AI endpoint answers (503 without a key is a pass: it means the route
#      is wired and only the provider is missing, which is the BYOK default)
#
# Usage: scripts/test-community-stack.sh [--tag 1.62.8] [--namespace prysmnote] [--keep]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${IMAGE_NAMESPACE:-prysmnote}"
TAG="${PRYSM_TAG:-latest}"
KEEP=0
WEB_PORT="${WEB_HOST_PORT:-3100}"
API_PORT="${API_HOST_PORT:-8100}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?}"; shift 2 ;;
    --namespace) NAMESPACE="${2:?}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

COMPOSE=(docker compose -p prysm-community-test -f "$ROOT/docker-compose.community.yml")

# Only ever touches the disposable `prysm-community-test` project and its own
# volume. The banned `-v` flags in AGENTS.md are about the dev/prod data volume,
# which this script never references.
cleanup() {
  if [ "$KEEP" = "0" ]; then
    "${COMPOSE[@]}" down >/dev/null 2>&1 || true
    docker volume rm prysm-community-test_postgres_data >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> booting community stack (${NAMESPACE}/prysm-note-*:$TAG) on $WEB_PORT/$API_PORT"
IMAGE_NAMESPACE="$NAMESPACE" PRYSM_TAG="$TAG" \
  WEB_HOST_PORT="$WEB_PORT" API_HOST_PORT="$API_PORT" \
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180

fail() { echo "FAIL: $1" >&2; docker compose -p prysm-community-test -f "$ROOT/docker-compose.community.yml" logs --tail 40 >&2 || true; exit 1; }

API="http://127.0.0.1:$API_PORT/api"
WEB="http://127.0.0.1:$WEB_PORT"
JAR="$(mktemp)"
trap 'rm -f "$JAR"; cleanup' EXIT

echo "==> health"
HEALTH="$(curl -fsS "$API/health" || fail "backend /api/health did not answer")"
echo "    $HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' || fail "health did not report ok"
echo "$HEALTH" | grep -q '"version"' || fail "health did not report a version"

echo "==> frontend"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$WEB/login")"
[ "$CODE" = "200" ] || fail "frontend /login returned $CODE"

echo "==> signup + task round-trip"
STAMP="$(date +%s)"
EMAIL="community-$STAMP@example.test"
PASS="community-test-$STAMP"

# The CSRF cookie (double-submit) is issued by a safe request, so seed it first.
curl -fsS -c "$JAR" -b "$JAR" "$API/health" >/dev/null || fail "could not seed the csrf cookie"

curl -fsS -c "$JAR" -b "$JAR" -X POST "$API/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"display_name\":\"Community\"}" >/dev/null \
  || fail "signup failed"

CSRF="$(awk '/csrf_token/ {print $7}' "$JAR" | tail -1)"
[ -n "$CSRF" ] || fail "no csrf cookie after signup"

CREATED="$(curl -fsS -c "$JAR" -b "$JAR" -X POST "$API/tasks" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"title":"Community edition smoke","priority":2}')" || fail "task create failed"
TASK_ID="$(printf '%s' "$CREATED" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).id||'')}catch{}})" )"
[ -n "$TASK_ID" ] || fail "task create returned no id"

curl -fsS -c "$JAR" -b "$JAR" "$API/tasks?limit=50" | grep -q 'Community edition smoke' \
  || fail "created task is missing from the task list"
echo "    created $TASK_ID and read it back"

# The CSRF token rotates with the session, so read it fresh before the next call.
CSRF="$(awk '/csrf_token/ {print $7}' "$JAR" | tail -1)"

echo "==> assistant route is wired"
AI_CODE="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -b "$JAR" -X POST "$API/ai/chat" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"message":"hello","provider":"prysmai"}')"
case "$AI_CODE" in
  200|400|402|503) echo "    /api/ai/chat answered $AI_CODE (wired)" ;;
  *) fail "/api/ai/chat answered $AI_CODE" ;;
esac

echo "COMMUNITY STACK PASS"
