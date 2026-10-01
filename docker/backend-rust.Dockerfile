# Development image for the Rust backend (prysm-server). The production image
# lives under deploy/ (private); this one ships with the open-core repo so the
# community dev stack (`docker compose up`) can run its backend.
FROM rust:1.83-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY apps/backend-rust/ ./
# No --locked here: the community build has crates/ee stripped, so the lockfile
# must be allowed to converge on the open-core workspace.
RUN cargo build --release --bin prysm-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 prysm
USER prysm
WORKDIR /app
COPY --from=builder /build/target/release/prysm-server /app/prysm-server
ENV PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
    CMD curl -fsS http://localhost:8000/api/health || exit 1
CMD ["/app/prysm-server"]
