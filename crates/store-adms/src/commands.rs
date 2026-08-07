//! Outbound command queue (CLAUDE.md §9).
//!
//! The device polls `/iclock/getrequest` and we answer with at most one queued
//! command. This is the only direction in which we talk *to* the terminal, and
//! it is used for pushing the operator master out to it — never for the door.
//! **We do not unlock anything** (§2): the terminal owns the lock, and it must
//! keep working when the server PC is off.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::protocol::CommandResult;

/// Something we want a terminal to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceCommand {
    /// Create or update a user record on the terminal.
    UpdateUser {
        pin: String,
        name: String,
        /// `0` = ordinary user, `14` = administrator on most firmware.
        privilege: u8,
    },
    /// Remove a user from the terminal.
    DeleteUser { pin: String },
    /// Ask the device to re-upload its user table.
    QueryUserInfo,
    /// Set the device clock. Sent as local time in the device's own format.
    SetTime { yyyymmddhhmmss: String },
    /// An escape hatch for firmware-specific commands discovered during
    /// `device-probe`. §9 warns that families differ; this is how we cope
    /// without a code change.
    Raw(String),
}

impl DeviceCommand {
    /// The command body, without the `C:<id>:` prefix.
    ///
    /// Fields are tab-separated — the same "not JSON, not REST" wire format the
    /// rest of §9 uses.
    pub fn body(&self) -> String {
        match self {
            DeviceCommand::UpdateUser {
                pin,
                name,
                privilege,
            } => {
                format!("DATA UPDATE USERINFO PIN={pin}\tName={name}\tPri={privilege}")
            }
            DeviceCommand::DeleteUser { pin } => {
                format!("DATA DELETE USERINFO PIN={pin}")
            }
            DeviceCommand::QueryUserInfo => "DATA QUERY USERINFO".to_owned(),
            DeviceCommand::SetTime { yyyymmddhhmmss } => {
                format!("SET TIME {yyyymmddhhmmss}")
            }
            DeviceCommand::Raw(raw) => raw.clone(),
        }
    }
}

/// A command that has been handed to a device and is awaiting its result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedCommand {
    pub id: String,
    pub serial: String,
    pub command: DeviceCommand,
}

impl QueuedCommand {
    /// The exact line the device expects on `/iclock/getrequest`.
    pub fn render(&self) -> String {
        format!("C:{}:{}", self.id, self.command.body())
    }
}

/// Per-device FIFO queues, plus the set of commands in flight.
///
/// In-memory on purpose: a command that did not survive a server restart is a
/// command the admin can simply re-issue, and persisting them would mean
/// reconciling our idea of device state with the device's on every boot.
#[derive(Debug, Default)]
pub struct CommandQueue {
    pending: Mutex<HashMap<String, VecDeque<QueuedCommand>>>,
    in_flight: Mutex<HashMap<String, QueuedCommand>>,
    next_id: AtomicU64,
}

impl CommandQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue a command for a device. Returns the command id the device will
    /// quote back on `/iclock/devicecmd`.
    pub fn enqueue(&self, serial: &str, command: DeviceCommand) -> String {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let queued = QueuedCommand {
            id: id.clone(),
            serial: serial.to_owned(),
            command,
        };

        self.pending
            .lock()
            .expect("command queue poisoned")
            .entry(serial.to_owned())
            .or_default()
            .push_back(queued);

        id
    }

    /// Hand the next command to a polling device, moving it in-flight.
    pub fn take_next(&self, serial: &str) -> Option<QueuedCommand> {
        let next = self
            .pending
            .lock()
            .expect("command queue poisoned")
            .get_mut(serial)
            .and_then(VecDeque::pop_front)?;

        self.in_flight
            .lock()
            .expect("command queue poisoned")
            .insert(next.id.clone(), next.clone());

        Some(next)
    }

    /// Record a result reported by the device.
    ///
    /// Returns the command it belonged to, if we still know about it. A result
    /// for an unknown id is not an error: the device may be reporting something
    /// queued before a restart.
    pub fn complete(&self, result: &CommandResult) -> Option<QueuedCommand> {
        let finished = self
            .in_flight
            .lock()
            .expect("command queue poisoned")
            .remove(&result.command_id);

        if let Some(cmd) = &finished {
            if !result.succeeded() {
                tracing::warn!(
                    command_id = %result.command_id,
                    serial = %cmd.serial,
                    return_code = ?result.return_code,
                    "device reported a command failure"
                );
            }
        }

        finished
    }

    /// Number of commands waiting for a given device.
    pub fn pending_count(&self, serial: &str) -> usize {
        self.pending
            .lock()
            .expect("command queue poisoned")
            .get(serial)
            .map_or(0, VecDeque::len)
    }

    /// Number of commands handed out but not yet reported on.
    pub fn in_flight_count(&self) -> usize {
        self.in_flight.lock().expect("command queue poisoned").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_user_update_renders_the_line_the_firmware_expects() {
        let q = QueuedCommand {
            id: "17".into(),
            serial: "ABC123".into(),
            command: DeviceCommand::UpdateUser {
                pin: "1042".into(),
                name: "R. Kumar".into(),
                privilege: 0,
            },
        };
        assert_eq!(
            q.render(),
            "C:17:DATA UPDATE USERINFO PIN=1042\tName=R. Kumar\tPri=0"
        );
    }

    #[test]
    fn commands_are_handed_out_in_order_and_only_once() {
        let queue = CommandQueue::new();
        queue.enqueue("SN1", DeviceCommand::QueryUserInfo);
        queue.enqueue("SN1", DeviceCommand::DeleteUser { pin: "9".into() });

        assert_eq!(queue.pending_count("SN1"), 2);
        assert_eq!(
            queue.take_next("SN1").unwrap().command,
            DeviceCommand::QueryUserInfo
        );
        assert_eq!(
            queue.take_next("SN1").unwrap().command,
            DeviceCommand::DeleteUser { pin: "9".into() }
        );
        assert!(queue.take_next("SN1").is_none());
        assert_eq!(queue.in_flight_count(), 2);
    }

    #[test]
    fn queues_are_per_device() {
        let queue = CommandQueue::new();
        queue.enqueue("SN1", DeviceCommand::QueryUserInfo);

        assert!(queue.take_next("SN2").is_none(), "SN2 got SN1's command");
        assert_eq!(queue.pending_count("SN1"), 1);
    }

    #[test]
    fn a_reported_result_clears_the_command() {
        let queue = CommandQueue::new();
        let id = queue.enqueue("SN1", DeviceCommand::QueryUserInfo);
        queue.take_next("SN1").unwrap();

        let done = queue.complete(&CommandResult {
            command_id: id.clone(),
            return_code: Some(0),
            command: Some("DATA".into()),
        });

        assert_eq!(done.map(|c| c.id), Some(id));
        assert_eq!(queue.in_flight_count(), 0);
    }

    #[test]
    fn a_result_for_an_unknown_command_is_tolerated() {
        // The device may be reporting something queued before a server restart.
        let queue = CommandQueue::new();
        let done = queue.complete(&CommandResult {
            command_id: "9999".into(),
            return_code: Some(0),
            command: None,
        });
        assert!(done.is_none());
    }
}
