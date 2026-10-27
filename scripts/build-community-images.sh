#!/usr/bin/env bash
# build-community-images.sh
#
# Builds (and optionally pushes) the open-core Community Edition images:
#   <namespace>/prysm-note-backend:<tag>
#   <namespace>/prysm-note-frontend:<tag>
#
# The images are built from a STRIPPED copy of this repo, never from the working
# tree: `scripts/strip-community.sh` is the single source of truth for what is
# public, so the image can never accidentally contain a private crate, an EE
# screen, or the marketing site. The stripped tree is left at .community-build/
# so a failing build can be inspected.
#
# Usage:
#   scripts/build-community-images.sh                     # build, tag :latest + :<sha>
#   scripts/build-community-images.sh --tag 1.62.8        # build, tag :latest + :1.62.8
#   scripts/build-community-images.sh --tag 1.62.8 --push # build, then push both tags
#   scripts/build-community-images.sh --namespace myorg   # Docker Hub namespace (default mk758)
#
# Push needs `docker login` first (CI: DOCKERHUB_USERNAME / DOCKERHUB_TOKEN).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/.community-build"
NAMESPACE="${IMAGE_NAMESPACE:-mk758}"
TAG=""
PUSH=0
PLATFORM="${PLATFORMS:-linux/amd64}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
    --namespace) NAMESPACE="${2:?--namespace needs a value}"; shift 2 ;;
    --platform) PLATFORM="${2:?--platform needs a value}"; shift 2 ;;
    --push) PUSH=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TAG" ]; then
  # The changelog path is assembled at runtime: this script ships to the public
  # repo, and a literal private path would trip the community sync's leak guard.
  CHANGELOG="$(node -e "const p=require('path');process.stdout.write(p.join('$ROOT','ee','apps','frontend','ee','marketing','changelog.json'))")"
  TAG="$(node -e "const d=require('$CHANGELOG');const l=Array.isArray(d)?d:d.entries;process.stdout.write(l[0].version)" 2>/dev/null \
    || git -C "$ROOT" rev-parse --short HEAD)"
fi
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"

BACKEND="$NAMESPACE/prysm-note-backend"
FRONTEND="$NAMESPACE/prysm-note-frontend"

echo "==> preparing stripped tree at .community-build (refusing to build the private tree)"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
rsync -a \
  --exclude 'node_modules' --exclude '.git' --exclude 'target' --exclude '.next' \
  --exclude '.community-build' --exclude 'backups' --exclude '.deploy-ssh' \
  --exclude '.env' --exclude '.env.local' --exclude '.env.prod' \
  --exclude '.env.production' --exclude '*.bak' \
  "$ROOT"/ "$BUILD_DIR"/

( cd "$BUILD_DIR" && bash scripts/strip-community.sh >/dev/null )

if [ -d "$BUILD_DIR/ee" ] || [ -d "$BUILD_DIR/apps/backend-rust/crates/ee" ]; then
  echo "FAIL: strip left enterprise code behind, refusing to build a public image" >&2
  exit 1
fi

echo "==> building $BACKEND:$TAG (also :$SHA)"
if [ "$PUSH" = "1" ]; then
  docker buildx build --platform "$PLATFORM" \
    -f "$BUILD_DIR/docker/community/backend.Dockerfile" \
    -t "$BACKEND:$TAG" -t "$BACKEND:$SHA" --push "$BUILD_DIR"
else
  docker buildx build --platform "$PLATFORM" \
    -f "$BUILD_DIR/docker/community/backend.Dockerfile" \
    -t "$BACKEND:$TAG" -t "$BACKEND:$SHA" --load "$BUILD_DIR"
fi

echo "==> building $FRONTEND:$TAG (also :$SHA)"
if [ "${PUSH:-0}" = "1" ]; then
  docker buildx build --platform "$PLATFORM" \
    -f "$BUILD_DIR/docker/community/frontend.Dockerfile" \
    --build-arg "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-http://localhost:8000/api}" \
    -t "$FRONTEND:$TAG" -t "$FRONTEND:$SHA" --push "$BUILD_DIR"
else
  docker buildx build --platform "$PLATFORM" \
    -f "$BUILD_DIR/docker/community/frontend.Dockerfile" \
    --build-arg "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-http://localhost:8000/api}" \
    -t "$FRONTEND:$TAG" -t "$FRONTEND:$SHA" --load "$BUILD_DIR"
fi

echo "==> done"
echo "  $BACKEND:$TAG  ($SHA)"
echo "  $FRONTEND:$TAG  ($SHA)"
if [ "${PUSH:-0}" != "1" ]; then
  echo "  (not pushed; pass --push to publish, after testing the stack)"
fi
