use axum::extract::{Query, State};
use axum::http::header::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use futures_util::stream::Stream;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RealtimeEventsQuery {
    #[serde(rename = "lastEventId")]
    pub last_event_id: Option<u64>,
    #[serde(rename = "clientId")]
    pub client_id: Option<String>,
}

pub async fn realtime_events_handler(
    State(state): State<AppState>,
    Query(query): Query<RealtimeEventsQuery>,
    headers: HeaderMap,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let last_id = query.last_event_id.or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
    });

    let (can_replay, replay_events) = match last_id {
        Some(id) if id > 0 => state.realtime_hub.get_replay_events(id).await,
        _ => (true, Vec::new()),
    };

    let active_gens = state.realtime_hub.get_active_generations().await;

    let ready_data = json!({
        "ready": true,
        "replay": can_replay && !replay_events.is_empty(),
        "resyncRequired": !can_replay,
        "activeGenerations": active_gens,
    });

    let ready_event = Event::default().event("ready").data(ready_data.to_string());

    let mut initial_events = vec![Ok(ready_event)];

    for rec in replay_events {
        let ev = Event::default()
            .id(rec.id.to_string())
            .event(rec.event)
            .data(rec.data.to_string());
        initial_events.push(Ok(ev));
    }

    let initial_stream = futures_util::stream::iter(initial_events);

    let rx = state.realtime_hub.subscribe();
    let broadcast_stream = BroadcastStream::new(rx).filter_map(|msg| async move {
        match msg {
            Ok(rec) => {
                let ev = Event::default()
                    .id(rec.id.to_string())
                    .event(rec.event)
                    .data(rec.data.to_string());
                Some(Ok(ev))
            }
            Err(_) => None,
        }
    });

    let combined = initial_stream.chain(broadcast_stream);

    Sse::new(combined).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

pub async fn update_generation_state_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let client_id = headers.get("x-client-id").and_then(|v| v.to_str().ok());

    match state
        .realtime_hub
        .update_generation_state(&payload, client_id)
        .await
    {
        Some(rec) => Json(json!({ "success": true, "record": rec })),
        None => Json(json!({ "success": false, "error": "Invalid generation state payload" })),
    }
}
