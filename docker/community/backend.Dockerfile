# Community Edition backend image (prysm-server, open-core).
#
# Build context MUST be a tree that has already been through
# `scripts/strip-community.sh` (no `ee/`, no `crates/ee`). The community build
# compiles with --no-default-features so the proprietary `prysm-ee` crate is not
# linked in; `scripts/build-community-images.sh` prepares that tree for you.
FROM rust:1.83-slim-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY apps/backend-rust/ ./
RUN cargo build --release --no-default-features --bin prysm-server

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 prysm

USER prysm
WORKDIR /app
COPY --from=builder /build/target/release/prysm-server /app/prysm-server

ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 \
    CMD curl -fsS "http://localhost:${PORT:-8000}/api/health" || exit 1

CMD ["/app/prysm-server"]
