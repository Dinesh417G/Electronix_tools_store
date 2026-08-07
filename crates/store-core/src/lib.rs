//! ElectronIx Tool Store — the domain.
//!
//! This crate is pure. It holds the three things a subtle bug would be most
//! expensive in (CLAUDE.md §15):
//!
//! * [`ledger`] — §7, the append-only stock ledger and its invariants;
//! * [`session`] — §10, the punch-claim state machine;
//! * [`identity`] — §8, the `IdentitySource` seam the ADMS listener sits behind.
//!
//! **Dependency rule (§5):** nothing in this crate may depend on anything else
//! in the workspace, and nothing here does I/O. No `sqlx`, no `axum`, no
//! runtime. If you find yourself reaching for one, restructure instead.

#![forbid(unsafe_code)]
#![warn(missing_debug_implementations)]

pub mod alert;
pub mod error;
pub mod identity;
pub mod item;
pub mod ledger;
pub mod session;

pub use error::{CoreError, Result};

pub use alert::{AlertAction, AlertLevel, StockPosition};
pub use identity::{IdentityEvent, IdentitySource, MockIdentitySource, VerifyMode};
pub use item::{BarcodeKind, Category, Item, ItemBarcode, StockPolicy, ToolingSpec, Uom};
pub use ledger::{LedgerEntry, Movement, Qty, TxnType};
pub use session::{
    CloseReason, IdentityStrength, Session, SessionEvent, SessionState, TabletId,
    TransitionError,
};
