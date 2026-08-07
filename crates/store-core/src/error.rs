//! Domain errors. Pure — no transport or database concepts leak in here.

use rust_decimal::Decimal;
use uuid::Uuid;

/// Everything the domain can refuse to do.
///
/// Transport-layer crates map these onto status codes; the mapping lives there,
/// not here, so that `store-core` stays ignorant of HTTP.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CoreError {
    #[error("quantity must be greater than zero, got {0}")]
    NonPositiveQuantity(Decimal),

    #[error("a ledger delta is never zero")]
    ZeroDelta,

    #[error("quantity {0} has more than {QTY_SCALE} decimal places")]
    QuantityTooPrecise(Decimal),

    #[error("quantity {0} exceeds the numeric(12,3) column range")]
    QuantityOutOfRange(Decimal),

    #[error(
        "insufficient stock for item {item_id}: {on_hand} on hand, {requested} requested"
    )]
    InsufficientStock {
        item_id: Uuid,
        on_hand: Decimal,
        requested: Decimal,
    },

    #[error("item code {0:?} is not a valid Code128 payload")]
    InvalidItemCode(String),

    #[error("barcode {0:?} is empty or contains unprintable characters")]
    InvalidBarcode(String),

    #[error("{0:?} is not a known unit of measure")]
    UnknownUom(String),

    #[error("{0:?} is not a known transaction type")]
    UnknownTxnType(String),

    #[error("{0:?} is not a known session state")]
    UnknownSessionState(String),

    #[error(transparent)]
    Transition(#[from] crate::session::TransitionError),
}

/// Decimal places on every quantity column — `numeric(12,3)`.
pub const QTY_SCALE: u32 = 3;

/// Result alias used throughout the domain.
pub type Result<T> = std::result::Result<T, CoreError>;
