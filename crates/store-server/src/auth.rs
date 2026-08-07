//! Request authentication (CLAUDE.md §11).
//!
//! > Tablets hold a device token; admin uses operator login. Every write
//! > carries an `operator_id` — there are no anonymous ledger rows.
//!
//! That last sentence is why [`Auth`] is an extractor rather than middleware:
//! a handler that writes to the ledger cannot compile without naming who is
//! doing it.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use store_db::auth::Principal;

use crate::error::ApiError;
use crate::state::AppState;

/// An authenticated caller.
#[derive(Debug, Clone)]
pub struct Auth(pub Principal);

impl Auth {
    /// The operator this request acts as.
    ///
    /// A tablet is not an operator: it acts *for* whoever claimed the session,
    /// so ledger writes from a tablet take their operator from the session, not
    /// from the token. Returning `None` here forces that at the type level.
    pub fn operator_id(&self) -> Option<uuid::Uuid> {
        match &self.0 {
            Principal::Operator { operator_id, .. } => Some(*operator_id),
            Principal::Tablet { .. } => None,
        }
    }

    /// Require an admin caller.
    pub fn require_admin(&self) -> Result<uuid::Uuid, ApiError> {
        match &self.0 {
            Principal::Operator {
                operator_id, role, ..
            } if role == "ADMIN" => Ok(*operator_id),
            _ => Err(ApiError::Forbidden(
                "This action needs an administrator login.".into(),
            )),
        }
    }

    /// Require a storekeeper or admin caller.
    pub fn require_storekeeper(&self) -> Result<uuid::Uuid, ApiError> {
        match &self.0 {
            Principal::Operator {
                operator_id, role, ..
            } if role == "ADMIN" || role == "STOREKEEPER" => Ok(*operator_id),
            _ => Err(ApiError::Forbidden(
                "This action needs a storekeeper login.".into(),
            )),
        }
    }

    /// Require a tablet caller, returning its id.
    pub fn require_tablet(&self) -> Result<&str, ApiError> {
        self.0
            .tablet_id()
            .ok_or_else(|| ApiError::Forbidden("This endpoint is for tablets.".into()))
    }
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or(ApiError::Unauthorized)?;

        let principal = store_db::auth::authenticate(&state.pool, token)
            .await?
            .ok_or(ApiError::Unauthorized)?;

        if let Principal::Tablet { tablet_id } = &principal {
            // Best-effort liveness, so the admin health view can show which
            // tablets are actually on the LAN.
            let _ = store_db::auth::touch_tablet(&state.pool, tablet_id).await;
        }

        Ok(Auth(principal))
    }
}

/// Authentication for the SSE stream.
///
/// `EventSource` — the only way a browser can hold a server-sent-events
/// connection — cannot set request headers, so the token has to travel in the
/// query string on this one route.
///
/// That is a real trade-off, not an oversight: a token in a URL can end up in
/// a proxy access log or a browser history entry. It is accepted here because
///
/// * it is scoped to exactly this route — every other endpoint takes the header
///   and nothing else, so a leaked stream URL cannot be replayed against
///   `/txn/issue` without also being a valid bearer token;
/// * the traffic is a plant LAN, not the public internet;
/// * a tablet token is revocable — re-enrolling the device invalidates it.
///
/// The header is still preferred when present, so a non-browser client (the
/// admin app, a test) never needs to put a secret in a URL.
#[derive(Debug, Clone)]
pub struct StreamAuth(pub Principal);

impl FromRequestParts<AppState> for StreamAuth {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let from_header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|t| t.trim().to_owned());

        let token = match from_header {
            Some(t) if !t.is_empty() => t,
            _ => parts
                .uri
                .query()
                .into_iter()
                .flat_map(|q| q.split('&'))
                .filter_map(|pair| pair.split_once('='))
                .find(|(key, _)| *key == "access_token")
                .map(|(_, value)| percent_decode(value))
                .filter(|t| !t.is_empty())
                .ok_or(ApiError::Unauthorized)?,
        };

        let principal = store_db::auth::authenticate(&state.pool, &token)
            .await?
            .ok_or(ApiError::Unauthorized)?;

        Ok(StreamAuth(principal))
    }
}

/// Minimal percent-decoding for the one query parameter we read by hand.
///
/// Tokens are hex, so this only ever has real work to do if something upstream
/// re-encodes the URL; decoding anyway costs nothing and avoids a baffling 401.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
