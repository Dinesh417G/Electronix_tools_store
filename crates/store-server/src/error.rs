//! Turning domain and database errors into HTTP.
//!
//! The mappings that matter are spelled out in the spec, and they are the ones
//! the tablet's UX depends on:
//!
//! * §7 — an ISSUE past zero is `409 Conflict`, and the tablet says
//!   *"Only 3 left in system — count the bin and adjust"*;
//! * §10 — work submitted after a session closes is `410 Gone`, and the tablet
//!   re-opens the claim screen rather than silently discarding the operator's
//!   typing.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use store_core::{CoreError, TransitionError};
use store_db::DbError;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),

    #[error("authentication required")]
    Unauthorized,

    #[error("{0}")]
    Forbidden(String),

    #[error("{0} not found")]
    NotFound(String),

    /// §7's negative-stock guard, and claim races.
    #[error("{0}")]
    Conflict(String),

    /// A conflict the client is expected to branch on rather than merely show:
    /// the console needs to tell "that code is taken" apart from "that would
    /// lock everybody out of the console". Same status, different remedy, so
    /// the difference has to survive the trip as something other than English.
    #[error("{message}")]
    CodedConflict { code: &'static str, message: String },

    /// §10: the session is closed or expired.
    #[error("{0}")]
    Gone(String),

    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

/// The error body every failing endpoint returns.
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    /// A stable machine-readable code, so the tablet can branch on the
    /// situation without parsing English.
    pub code: &'static str,
    /// A sentence fit to show an operator with oily gloves.
    pub message: String,
}

impl ApiError {
    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            ApiError::CodedConflict { code, .. } => (StatusCode::CONFLICT, code),
            ApiError::Gone(_) => (StatusCode::GONE, "session_gone"),
            ApiError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.parts();

        let message = match &self {
            // Never leak internals to a shop-floor screen; the detail goes to
            // the log where an engineer can find it.
            ApiError::Internal(err) => {
                tracing::error!(error = ?err, "unhandled server error");
                "Something went wrong on the server. Try again.".to_owned()
            }
            other => other.to_string(),
        };

        (status, Json(ErrorBody { code, message })).into_response()
    }
}

impl From<DbError> for ApiError {
    fn from(err: DbError) -> Self {
        match err {
            // §7. The message is written to be shown verbatim on the tablet.
            DbError::InsufficientStock(detail) => ApiError::Conflict(detail),

            DbError::LedgerAppendOnly => ApiError::Conflict(
                "The stock ledger is append-only. Correct this with a reversal.".into(),
            ),

            DbError::NotFound { entity } => ApiError::NotFound(entity.to_owned()),

            // §11: the last active ADMIN cannot leave through this API.
            DbError::LastAdmin => ApiError::CodedConflict {
                code: "LAST_ADMIN",
                message: DbError::LastAdmin.to_string(),
            },

            DbError::Conflict(what) => ApiError::Conflict(format!("{what} already exists")),

            DbError::Invalid(detail) => ApiError::BadRequest(detail),

            DbError::Domain(core) => core.into(),

            DbError::Sqlx(e) => ApiError::Internal(anyhow::Error::new(e)),
            DbError::Migrate(e) => ApiError::Internal(anyhow::Error::new(e)),
        }
    }
}

impl From<CoreError> for ApiError {
    fn from(err: CoreError) -> Self {
        match err {
            CoreError::InsufficientStock {
                on_hand, requested, ..
            } => ApiError::Conflict(format!(
                "Only {on_hand} left in system — count the bin and adjust. \
                         You asked for {requested}."
            )),
            CoreError::Transition(t) => t.into(),
            // Everything else is the caller handing us something malformed.
            other => ApiError::BadRequest(other.to_string()),
        }
    }
}

impl From<TransitionError> for ApiError {
    fn from(err: TransitionError) -> Self {
        match err {
            // §10: the tablet re-opens the claim screen on a 410.
            TransitionError::SessionClosed => {
                ApiError::Gone("That session has closed. Tap your name again.".into())
            }
            TransitionError::SessionExpired => ApiError::Gone(
                "That punch expired. Put your finger on the door reader again.".into(),
            ),
            TransitionError::AlreadyClaimed { claimed_by } => {
                ApiError::Conflict(format!("Already in use on tablet {claimed_by}."))
            }
            TransitionError::NotClaimed => {
                ApiError::Conflict("Tap your name on the claim screen first.".into())
            }
            other => ApiError::BadRequest(other.to_string()),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
