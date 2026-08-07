//! ZKTeco ADMS "Push" wire format — CLAUDE.md §9.
//!
//! The device is the client; we are the ADMS host. It speaks plain HTTP with
//! `key=value` query strings and tab-separated bodies. It is **not** REST and
//! **not** JSON. Do not try to make it pretty — every deviation from what the
//! firmware expects shows up as a device that silently stops pushing.
//!
//! > ⚠️ §9 warns that firmware families vary in casing, parameter names and
//! > stamp semantics. Everything here is written to be forgiving about case and
//! > whitespace, and to record rather than reject what it does not recognise.
//! > `store-cli device-probe` captures real traffic so this can be checked
//! > against a physical terminal at M2.

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use store_core::identity::{IdentityEvent, VerifyMode};

/// How the device formats timestamps in ATTLOG rows.
const DEVICE_TS_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

/// One parsed attendance record.
///
/// This is the punch as the *device* describes it. Turning it into an
/// [`IdentityEvent`] is a separate step, because the device's account of when
/// something happened is not one we trust (§9.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttlogRecord {
    /// The PIN / user id programmed into the terminal.
    pub user_id: String,
    /// What the device's clock said. Diagnostic only.
    pub device_ts: Option<DateTime<Utc>>,
    /// Check-in / check-out status code. We are a tool crib, not a payroll
    /// system, so this is recorded and otherwise ignored.
    pub status: Option<i32>,
    pub verify_mode: VerifyMode,
    pub work_code: Option<String>,
    /// The original line, verbatim.
    pub raw: String,
}

impl AttlogRecord {
    /// Promote to the domain event the session service consumes.
    pub fn to_identity_event(&self, device_serial: &str) -> IdentityEvent {
        IdentityEvent {
            external_user_id: self.user_id.clone(),
            device_serial: device_serial.to_owned(),
            device_ts: self.device_ts,
            verify_mode: self.verify_mode,
            raw: self.raw.clone(),
        }
    }
}

/// Why a line could not be parsed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    #[error("record has no user id")]
    MissingUserId,
    #[error("record has too few fields: {0:?}")]
    TooFewFields(String),
}

/// Parse an ATTLOG body into records.
///
/// Body format (§9):
/// ```text
/// <userid>\t<yyyy-MM-dd HH:mm:ss>\t<status>\t<verify>\t<workcode>\t<reserved>
/// ```
///
/// Returns `(records, rejected)`. Malformed lines are returned rather than
/// dropped, because §9.4's principle — never lose data because our
/// understanding is incomplete — applies to shapes as much as to users. The
/// caller logs them and still answers `OK`, since arguing with the firmware
/// only makes it retry the whole batch forever.
pub fn parse_attlog(body: &str) -> (Vec<AttlogRecord>, Vec<(String, ParseError)>) {
    let mut records = Vec::new();
    let mut rejected = Vec::new();

    for line in body.lines() {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.trim().is_empty() {
            continue;
        }
        match parse_attlog_line(trimmed) {
            Ok(record) => records.push(record),
            Err(err) => rejected.push((trimmed.to_owned(), err)),
        }
    }

    (records, rejected)
}

/// Parse one tab-separated ATTLOG line.
///
/// Deliberately lenient about trailing fields: firmware families disagree about
/// how many they send, and a terminal that appends two extra reserved columns
/// is still telling us who walked in.
pub fn parse_attlog_line(line: &str) -> Result<AttlogRecord, ParseError> {
    // Some firmware pads with spaces around tabs.
    let fields: Vec<&str> = line.split('\t').map(str::trim).collect();

    if fields.is_empty() {
        return Err(ParseError::TooFewFields(line.to_owned()));
    }

    let user_id = fields[0].trim();
    if user_id.is_empty() {
        return Err(ParseError::MissingUserId);
    }

    // Everything past the user id is optional. A record with only a user id is
    // still a person at the door.
    let device_ts = fields.get(1).and_then(|s| parse_device_ts(s));
    let status = fields.get(2).and_then(|s| s.parse::<i32>().ok());
    let verify_mode = fields
        .get(3)
        .and_then(|s| s.parse::<u8>().ok())
        .map(VerifyMode::from_code)
        .unwrap_or(VerifyMode::Other(0));
    let work_code = fields
        .get(4)
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty() && s != "0");

    Ok(AttlogRecord {
        user_id: user_id.to_owned(),
        device_ts,
        status,
        verify_mode,
        work_code,
        raw: line.to_owned(),
    })
}

/// Parse the device's timestamp, treating it as UTC.
///
/// §9.3: device clocks are not trusted. We record what the terminal claimed and
/// then use `received_at` for every business decision, so getting the zone
/// wrong here is a diagnostic inconvenience rather than a correctness problem.
/// Interpreting a naive local time as UTC is a deliberate choice: it is
/// reversible given the device's configured offset, whereas guessing an offset
/// is not.
pub fn parse_device_ts(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    NaiveDateTime::parse_from_str(trimmed, DEVICE_TS_FORMAT)
        .ok()
        .and_then(|naive| Utc.from_local_datetime(&naive).single())
}

/// Parameters extracted from an `/iclock/*` query string.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceQuery {
    /// The device serial number. Present on every request.
    pub serial: Option<String>,
    pub table: Option<String>,
    pub options: Option<String>,
    pub pushver: Option<String>,
    pub language: Option<String>,
}

impl DeviceQuery {
    /// Parse a raw query string, case-insensitively on keys.
    ///
    /// Firmware families disagree on casing — `SN` and `sn` both appear in the
    /// wild — so key matching is normalised rather than exact.
    pub fn parse(raw_query: &str) -> Self {
        let mut out = DeviceQuery::default();
        for pair in raw_query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match key.trim().to_ascii_lowercase().as_str() {
                "sn" => out.serial = Some(value.to_owned()),
                "table" => out.table = Some(value.to_ascii_uppercase()),
                "options" => out.options = Some(value.to_owned()),
                "pushver" => out.pushver = Some(value.to_owned()),
                "language" => out.language = Some(value.to_owned()),
                _ => {}
            }
        }
        out
    }
}

/// Options block returned to a device on handshake (§9).
///
/// The field names and the trailing newline matter to the firmware; this is one
/// place where being "tidy" breaks things.
#[derive(Debug, Clone)]
pub struct HandshakeOptions {
    pub serial: String,
    /// Minutes east of UTC. India is +330.
    pub timezone_offset_min: i32,
    /// Seconds between polls when the device is idle.
    pub delay_secs: u32,
    /// Seconds to wait after an error before retrying.
    pub error_delay_secs: u32,
    /// `1` asks the device to push each punch as it happens rather than
    /// batching. This is what makes the tablet wake before the operator has
    /// finished walking to it.
    pub realtime: bool,
}

impl HandshakeOptions {
    /// Sensible defaults for a store terminal on a plant LAN.
    pub fn new(serial: impl Into<String>) -> Self {
        HandshakeOptions {
            serial: serial.into(),
            // +05:30. §9 flags Indian half-hour offsets as a known trouble spot
            // on some ZK firmwares — which is exactly why nothing downstream
            // depends on the device agreeing with us about the time.
            timezone_offset_min: 330,
            delay_secs: 10,
            error_delay_secs: 30,
            realtime: true,
        }
    }

    /// Render the plain-text response body.
    pub fn render(&self) -> String {
        // TimeZone is expressed in hours by this protocol; a half-hour offset
        // cannot be represented, which is the root of the drift §9.3 warns
        // about. We send the nearest hour and rely on received_at.
        let tz_hours = self.timezone_offset_min / 60;
        format!(
            "GET OPTION FROM: {sn}\n\
             ATTLOGStamp=0\n\
             OPERLOGStamp=0\n\
             ErrorDelay={error_delay}\n\
             Delay={delay}\n\
             TransTimes=00:00;14:00\n\
             TransInterval=1\n\
             TransFlag=111111111111\n\
             Realtime={realtime}\n\
             ServerVer=3.0.1\n\
             TimeZone={tz}\n",
            sn = self.serial,
            error_delay = self.error_delay_secs,
            delay = self.delay_secs,
            realtime = u8::from(self.realtime),
            tz = tz_hours,
        )
    }
}

/// The acknowledgement the device requires after an ATTLOG push (§9).
///
/// **Must** be exactly `OK: <n>`. A non-OK or slow response makes the device
/// retry, which duplicates records.
pub fn attlog_ack(count: usize) -> String {
    format!("OK: {count}")
}

/// A command result reported back by the device on `/iclock/devicecmd`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub command_id: String,
    /// `0` means success on every firmware we have seen.
    pub return_code: Option<i32>,
    pub command: Option<String>,
}

impl CommandResult {
    pub fn succeeded(&self) -> bool {
        self.return_code == Some(0)
    }
}

/// Parse the `ID=..&Return=..&CMD=..` body a device posts after running a
/// command. Multiple results may arrive in one body, one per line.
pub fn parse_command_results(body: &str) -> Vec<CommandResult> {
    body.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut id = None;
            let mut ret = None;
            let mut cmd = None;
            for pair in line.trim().split('&') {
                let Some((key, value)) = pair.split_once('=') else {
                    continue;
                };
                match key.trim().to_ascii_uppercase().as_str() {
                    "ID" => id = Some(value.trim().to_owned()),
                    "RETURN" => ret = value.trim().parse::<i32>().ok(),
                    "CMD" => cmd = Some(value.trim().to_owned()),
                    _ => {}
                }
            }
            id.map(|command_id| CommandResult {
                command_id,
                return_code: ret,
                command: cmd,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_standard_attlog_line_parses() {
        let line = "1042\t2026-08-07 14:32:11\t0\t2\t0\t0";
        let r = parse_attlog_line(line).unwrap();

        assert_eq!(r.user_id, "1042");
        assert_eq!(
            r.device_ts,
            Some(Utc.with_ymd_and_hms(2026, 8, 7, 14, 32, 11).unwrap())
        );
        assert_eq!(r.status, Some(0));
        assert_eq!(r.verify_mode, VerifyMode::Fingerprint);
        assert_eq!(r.work_code, None);
        assert_eq!(r.raw, line);
    }

    #[test]
    fn a_batch_body_parses_every_line() {
        let body = "1042\t2026-08-07 14:32:11\t0\t2\t0\t0\n\
                    2077\t2026-08-07 14:33:05\t0\t3\t0\t0\n";
        let (records, rejected) = parse_attlog(body);

        assert_eq!(records.len(), 2);
        assert!(rejected.is_empty());
        assert_eq!(records[0].user_id, "1042");
        assert_eq!(records[1].verify_mode, VerifyMode::Card);
    }

    #[test]
    fn blank_lines_and_crlf_are_tolerated() {
        let body = "1042\t2026-08-07 14:32:11\t0\t2\t0\t0\r\n\r\n\
                    2077\t2026-08-07 14:33:05\t0\t2\t0\t0\r\n";
        let (records, rejected) = parse_attlog(body);
        assert_eq!(records.len(), 2);
        assert!(rejected.is_empty());
    }

    #[test]
    fn extra_trailing_fields_do_not_break_a_record() {
        // Firmware families disagree about how many reserved columns to send.
        let line = "1042\t2026-08-07 14:32:11\t0\t2\t0\t0\t\t99\textra";
        let r = parse_attlog_line(line).unwrap();
        assert_eq!(r.user_id, "1042");
        assert_eq!(r.verify_mode, VerifyMode::Fingerprint);
    }

    #[test]
    fn a_record_with_only_a_user_id_is_still_a_person_at_the_door() {
        let r = parse_attlog_line("1042").unwrap();
        assert_eq!(r.user_id, "1042");
        assert_eq!(r.device_ts, None);
        assert_eq!(r.verify_mode, VerifyMode::Other(0));
    }

    #[test]
    fn an_unparseable_timestamp_does_not_lose_the_punch() {
        // §9.3: device_ts is diagnostic. A garbled clock must not cost us the
        // record that somebody opened the door.
        let r = parse_attlog_line("1042\tnot-a-date\t0\t2\t0\t0").unwrap();
        assert_eq!(r.user_id, "1042");
        assert_eq!(r.device_ts, None);
    }

    #[test]
    fn a_line_with_no_user_id_is_rejected_not_silently_kept() {
        assert_eq!(
            parse_attlog_line("\t2026-08-07 14:32:11\t0\t2"),
            Err(ParseError::MissingUserId)
        );
        let (records, rejected) = parse_attlog("\t2026-08-07 14:32:11\t0\t2\n1042\t\t0\t2\n");
        assert_eq!(records.len(), 1);
        assert_eq!(
            rejected.len(),
            1,
            "malformed lines are reported, not dropped"
        );
    }

    #[test]
    fn an_unknown_verify_code_is_recorded() {
        let r = parse_attlog_line("1042\t2026-08-07 14:32:11\t0\t200\t0\t0").unwrap();
        assert_eq!(r.verify_mode, VerifyMode::Other(200));
    }

    #[test]
    fn work_codes_are_kept_when_present() {
        let r = parse_attlog_line("1042\t2026-08-07 14:32:11\t0\t2\tWC7\t0").unwrap();
        assert_eq!(r.work_code.as_deref(), Some("WC7"));
    }

    #[test]
    fn query_parsing_is_case_insensitive_on_keys() {
        let q = DeviceQuery::parse("sn=ABC123&Table=attlog&pushver=2.4.1");
        assert_eq!(q.serial.as_deref(), Some("ABC123"));
        assert_eq!(q.table.as_deref(), Some("ATTLOG"));
        assert_eq!(q.pushver.as_deref(), Some("2.4.1"));

        let q = DeviceQuery::parse("SN=ABC123&options=all");
        assert_eq!(q.serial.as_deref(), Some("ABC123"));
        assert_eq!(q.options.as_deref(), Some("all"));
    }

    #[test]
    fn empty_query_values_are_treated_as_absent() {
        let q = DeviceQuery::parse("SN=&table=ATTLOG");
        assert_eq!(q.serial, None);
    }

    #[test]
    fn the_handshake_block_has_the_shape_the_firmware_expects() {
        let rendered = HandshakeOptions::new("ABC123").render();

        assert!(rendered.starts_with("GET OPTION FROM: ABC123\n"));
        for required in [
            "ATTLOGStamp=0",
            "OPERLOGStamp=0",
            "ErrorDelay=30",
            "Delay=10",
            "TransTimes=00:00;14:00",
            "TransInterval=1",
            "TransFlag=111111111111",
            "Realtime=1",
            "ServerVer=3.0.1",
            "TimeZone=5",
        ] {
            assert!(rendered.contains(required), "missing {required}");
        }
        assert!(
            rendered.ends_with('\n'),
            "firmware expects a trailing newline"
        );
    }

    #[test]
    fn the_ack_is_exactly_what_the_device_demands() {
        // §9: anything else makes the device retry and duplicate records.
        assert_eq!(attlog_ack(0), "OK: 0");
        assert_eq!(attlog_ack(500), "OK: 500");
    }

    #[test]
    fn command_results_parse() {
        let results =
            parse_command_results("ID=17&Return=0&CMD=DATA\nID=18&Return=-1&CMD=DATA");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].command_id, "17");
        assert!(results[0].succeeded());
        assert!(!results[1].succeeded());
    }
}
