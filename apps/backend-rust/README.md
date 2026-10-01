# Prysm Note backend (Rust)

The Prysm Note backend is a Rust workspace (axum + tokio + sqlx) that serves the
HTTP/JSON API, Server-Sent Events (`GET /api/events`) and the MCP endpoint
(`/api/mcp`). This is the open-core (AGPL) build.

## Layout

- `crates/core` (`prysm-core`): the server plus the community features.
- `crates/server` (`prysm-server`): the binary that wires the crates together.

## Build and run

```bash
cargo run -p prysm-server
```

The server reads its configuration from the environment (see `.env.example` at
the repo root) and provisions its own database schema on first boot.

## Community build

```bash
cargo build --no-default-features -p prysm-server
```

## Tests

```bash
cargo test
```
