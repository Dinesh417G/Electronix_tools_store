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
