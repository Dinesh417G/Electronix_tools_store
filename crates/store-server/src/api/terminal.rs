//! `GET /api/v1/terminal/status` — what the idle screen needs, in one request.
//!
//! §3 used to promise a door reader ("1× ZKTeco access terminal"), and the
//! terminal read that as a promise: its idle screen told every operator to put
//! a finger on a reader whether or not one existed. Nothing in the software
//! ever required it — §8 has three other identity sources, §10's manual path
//! was built for exactly this, and §2's "the terminal owns the lock" means we
//! were never in that loop anyway. What was missing was the app knowing which
//! kind of crib it is standing in.

use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;

use crate::auth::Auth;
use crate::error::ApiResult;
use crate::state::AppState;

/// A device quiet for longer than this is installed but not talking.
const ONLINE_WINDOW_MIN: i64 = 15;

/// An unbounded client-supplied window is an unbounded scan, so the day the
/// tablet claims is clamped to something a working day can actually be.
const OLDEST_WINDOW_HOURS: i64 = 48;

#[derive(Debug, Deserialize)]
pub struct StatusQuery {
    /// The tablet's local midnight. See `store_db::terminal::status`.
    pub since: Option<DateTime<Utc>>,
}

/// `GET /api/v1/terminal/status`
///
/// Authenticated as any caller — the terminal's device token is enough, which
/// is the point: §11 gives a tablet no operator identity, and this is the one
/// question it has to answer before it can word its own idle screen.
pub async fn status(
    State(state): State<AppState>,
    _auth: Auth,
    Query(q): Query<StatusQuery>,
) -> ApiResult<impl IntoResponse> {
    let now = Utc::now();
    let since = match q.since {
        Some(claimed)
            if claimed <= now && claimed >= now - Duration::hours(OLDEST_WINDOW_HOURS) =>
        {
            claimed
        }
        // No day, or one this tablet could not plausibly be standing in.
        _ => now - Duration::hours(24),
    };

    let (reader, today, recent) = store_db::terminal::status(&state.pool, since).await?;

    // `installed` is "ever", `online` is "lately". Flattening them would turn a
    // reader that is down for an hour into a crib that never had one, and the
    // two need opposite remedies (§3).
    let online = reader
        .last_seen_at
        .is_some_and(|seen| now - seen < Duration::minutes(ONLINE_WINDOW_MIN));

    Ok(Json(serde_json::json!({
        "reader": {
            "installed": reader.installed,
            "online": online,
            "last_seen_at": reader.last_seen_at,
        },
        "today": today,
        "recent": recent,
    })))
}
