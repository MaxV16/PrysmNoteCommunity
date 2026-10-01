//! Real-time change bus and the `GET /api/events` SSE endpoint.
//!
//! This mirrors the Python `app/services/events.py` + `app/routers/events.py`:
//! mutations publish a per-user "something changed" signal, and an authenticated
//! SSE stream fans the signal back out to the owning browser. The in-process
//! `broadcast` channel is the single-worker equivalent of Python's asyncio queue
//! registry (Redis pub/sub is a later, multi-worker optimization).

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::Router;
use serde_json::json;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use uuid::Uuid;

use crate::auth;
use crate::error::ApiError;
use crate::AppState;

/// Resource prefixes whose mutations publish a change event. Match is exact or
/// `prefix` followed by `/`, mirroring Python's `_RESOURCE_PREFIXES`.
pub const RESOURCE_PREFIXES: &[(&str, &str)] = &[
    ("/api/tasks", "tasks"),
    ("/api/tags", "tags"),
    ("/api/lists", "lists"),
    ("/api/board-sections", "board_sections"),
    ("/api/notes", "notes"),
    ("/api/preferences", "preferences"),
    ("/api/watchlist", "watchlist"),
    ("/api/habits", "habits"),
    ("/api/finance", "finance"),
];

/// Map a request path to its resource name, or `None` when it is not a watched
/// mutation surface.
pub fn match_resource(path: &str) -> Option<&'static str> {
    for (prefix, resource) in RESOURCE_PREFIXES {
        if path == *prefix || path.starts_with(&format!("{prefix}/")) {
            return Some(resource);
        }
    }
    None
}

/// A single change signal addressed to one user.
#[derive(Clone, Debug)]
pub struct UserEvent {
    pub user_id: Uuid,
    pub resource: String,
}

/// In-process, per-user change bus. Cheap to clone (shared broadcast sender).
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<UserEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(256);
        Self { tx }
    }

    /// Fire-and-forget publish; never fails the caller.
    pub fn publish(&self, user_id: Uuid, resource: &str) {
        let _ = self.tx.send(UserEvent {
            user_id,
            resource: resource.to_string(),
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<UserEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/events", get(stream_events))
}

/// `GET /api/events` - authenticated `text/event-stream`. Emits `retry: 5000`
/// and a `: connected` comment first, then `event: change` frames, with a
/// keep-alive `: ping` every 15s (Python's heartbeat cadence).
async fn stream_events(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let token = auth::token_from_headers(&headers)
        .ok_or_else(|| ApiError::Unauthorized("Could not validate credentials".to_string()))?;
    let user = auth::authenticate(&state.settings.jwt_secret_key, &token)?;
    let user_id = user.user_id;

    let initial = tokio_stream::iter(vec![
        Ok(Event::default().retry(Duration::from_secs(5))),
        Ok(Event::default().comment("connected")),
    ]);
    let changes = BroadcastStream::new(state.events.subscribe()).filter_map(move |msg| match msg {
        Ok(event) if event.user_id == user_id => {
            let payload = json!({ "resource": event.resource, "ids": [] }).to_string();
            Some(Ok(Event::default().event("change").data(payload)))
        }
        _ => None,
    });

    Ok(Sse::new(initial.chain(changes))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_prefixes_match_exactly_or_with_a_subpath() {
        assert_eq!(match_resource("/api/tasks"), Some("tasks"));
        assert_eq!(match_resource("/api/tasks/123"), Some("tasks"));
        assert_eq!(match_resource("/api/habits"), Some("habits"));
        assert_eq!(match_resource("/api/health"), None);
        assert_eq!(match_resource("/api/auth/login"), None);
    }

    #[tokio::test]
    async fn events_are_delivered_only_to_the_owning_user() {
        let bus = EventBus::new();
        let mine = bus.subscribe();
        let theirs = bus.subscribe();
        let me = Uuid::new_v4();
        let other = Uuid::new_v4();

        bus.publish(me, "tasks");
        bus.publish(other, "habits");

        let received: Vec<UserEvent> = BroadcastStream::new(mine)
            .filter_map(|m| m.ok())
            .take(2)
            .collect()
            .await;
        let mine_count = received.iter().filter(|e| e.user_id == me).count();
        let other_count = received.iter().filter(|e| e.user_id == other).count();
        assert_eq!(mine_count, 1);
        assert_eq!(other_count, 1);

        let theirs_first = BroadcastStream::new(theirs).next().await.unwrap().unwrap();
        assert_eq!(theirs_first.resource, "tasks");
    }
}
