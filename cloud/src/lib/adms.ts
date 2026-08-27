// The ZKTeco ADMS "Push" protocol (CLAUDE.md §9), ported from
// `crates/store-adms/src/protocol.rs`.
//
// The device is the client; we are the host. It is plain HTTP with key=value
// query strings and tab-separated bodies — not REST, not JSON. Do not try to
// make it pretty.
//
// ⚠️ §9 carries a warning worth repeating here: firmware families vary in
// casing, parameter names and stamp semantics. Nothing in this file has been
// checked against real hardware yet. `store-cli device-probe` and a capture are
// still the only way to know.

export type VerifyMode = "FINGERPRINT" | "CARD" | "FACE" | "PASSWORD" | "OTHER";

/** Verify codes as the firmware families we know about report them. */
export function verifyModeFromCode(code: number): VerifyMode {
  switch (code) {
    case 0:
    case 1:
      return "PASSWORD";
    case 2:
      return "FINGERPRINT";
    case 3:
    case 4:
      return "CARD";
    case 15:
    case 25:
      return "FACE";
    default:
      return "OTHER";
  }
}

export interface AttlogRecord {
  userId: string;
  /** What the device's clock said. Diagnostic only. */
  deviceTs: Date | null;
  status: number | null;
  verifyMode: VerifyMode;
  workCode: string | null;
  /** The original line, verbatim. */
  raw: string;
}

/**
 * Parse the device's timestamp, treating it as UTC.
 *
 * §9.3: device clocks are not trusted. We record what the terminal claimed and
 * then use `received_at` for every business decision, so getting the zone wrong
 * here is a diagnostic inconvenience rather than a correctness problem.
 * Interpreting a naive local time as UTC is deliberate: it is reversible given
 * the device's configured offset, whereas guessing an offset is not.
 */
export function parseDeviceTs(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (!m) return null;

  const [, y, mo, d, h, mi, s] = m;
  const ts = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isNaN(ts) ? null : new Date(ts);
}

/**
 * Parse one tab-separated ATTLOG line.
 *
 * Deliberately lenient about trailing fields: firmware families disagree about
 * how many they send, and a terminal that appends two extra reserved columns is
 * still telling us who walked in.
 */
export function parseAttlogLine(line: string): AttlogRecord | null {
  // Some firmware pads with spaces around tabs.
  const fields = line.split("\t").map((f) => f.trim());

  const userId = fields[0]?.trim();
  if (!userId) return null;

  // Everything past the user id is optional. A record with only a user id is
  // still a person at the door.
  const deviceTs = fields[1] ? parseDeviceTs(fields[1]) : null;
  const status = fields[2] ? toInt(fields[2]) : null;
  const verifyMode = fields[3] ? verifyModeFromCode(toInt(fields[3]) ?? 0) : "OTHER";
  const workCode = fields[4] && fields[4] !== "0" ? fields[4] : null;

  return { userId, deviceTs, status, verifyMode, workCode, raw: line };
}

export function parseAttlog(body: string): { records: AttlogRecord[]; rejected: string[] } {
  const records: AttlogRecord[] = [];
  const rejected: string[] = [];

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.replace(/[\r\n]+$/, "");
    if (!trimmed.trim()) continue;

    const record = parseAttlogLine(trimmed);
    if (record) records.push(record);
    else rejected.push(trimmed);
  }

  return { records, rejected };
}

function toInt(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Query parameters from an `/iclock/*` request.
 *
 * Firmware families disagree on casing — `SN` and `sn` both appear in the wild
 * — so key matching is normalised rather than exact.
 */
export function deviceQuery(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URL(url).searchParams) {
    const v = value.trim();
    if (v) out[key.toLowerCase()] = v;
  }
  return out;
}

export interface DeviceOptions {
  serial: string;
  delaySecs?: number;
  errorDelaySecs?: number;
  realtime?: boolean;
  timezoneOffsetMinutes?: number;
}

/**
 * The handshake reply a device expects on boot.
 *
 * Field names and order are the device's, not ours. `TimeZone` is in hours
 * because that is what the firmware parses, which is also why an Indian
 * half-hour offset is a known trouble spot (§9.3).
 */
export function optionsBlock(o: DeviceOptions): string {
  const tzHours = ((o.timezoneOffsetMinutes ?? 0) / 60).toFixed(0);
  return [
    `GET OPTION FROM: ${o.serial}`,
    "ATTLOGStamp=0",
    "OPERLOGStamp=0",
    `ErrorDelay=${o.errorDelaySecs ?? 30}`,
    `Delay=${o.delaySecs ?? 10}`,
    "TransTimes=00:00;14:00",
    "TransInterval=1",
    "TransFlag=111111111111",
    `Realtime=${o.realtime === false ? 0 : 1}`,
    "ServerVer=3.0.1",
    `TimeZone=${tzHours}`,
    "",
  ].join("\n");
}

/**
 * The acknowledgement the device requires after an ATTLOG push (§9).
 *
 * **Must** be exactly `OK: <n>`. A non-OK or slow response makes the device
 * retry, which duplicates records.
 */
export function attlogAck(count: number): string {
  return `OK: ${count}`;
}

/** Plain text, no charset games — the device's parser is not a browser. */
export function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
