//! ZKTeco ADMS "Push" protocol — CLAUDE.md §9.
//!
//! The device is the client and we are the host. It speaks plain HTTP with
//! tab-separated bodies, it retries anything we do not acknowledge crisply, and
//! its clock cannot be trusted. Those three facts drive every design decision
//! in this crate.
//!
//! **Dependency rule (§5):** this crate depends on `store-core` only. It has no
//! database access; persistence arrives through the [`routes::PunchSink`] trait
//! that the server implements.
//!
//! What this crate deliberately does *not* do is open the door. §2: the
//! terminal owns the lock and unlocks it on its own, so the store keeps working
//! when the server PC is off. We are observers.

#![forbid(unsafe_code)]

pub mod commands;
pub mod mock_device;
pub mod protocol;
pub mod routes;

pub use commands::{CommandQueue, DeviceCommand, QueuedCommand};
pub use mock_device::MockDevice;
pub use protocol::{parse_attlog, AttlogRecord, DeviceQuery, HandshakeOptions};
pub use routes::{router, AdmsIdentitySource, AdmsState, PunchSink, SinkError};
