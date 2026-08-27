// Running serial numbers — one per physical tool, not per catalog line.
//
// Forty identical inserts in bin A-01-1 are one item and forty stickers, and
// the whole point of the number is telling those forty apart. The uniqueness
// that makes that true is a database constraint (`tool_serials.serial_no`
// UNIQUE), not a check in this file: a serial that could be typed onto two
// tools is not a serial.

import { sql } from "./db";
import { ApiError } from "./errors";

export interface ToolSerial {
  id: string;
  item_id: string;
  serial_no: string;
  minted: boolean;
  status: "ACTIVE" | "RETIRED";
  note: string | null;
  print_count: number;
  first_printed_at: Date | null;
  last_printed_at: Date | null;
  created_at: Date;
  item_code?: string;
  description?: string;
}

/**
 * Mint `count` new serials for an item.
 *
 * The numbers come from a Postgres sequence, so two storekeepers minting at the
 * same moment cannot collide — `nextval` is exempt from transaction isolation
 * precisely so it can hand out unique values under concurrency.
 *
 * Gaps are possible (a rolled-back transaction keeps its consumed value) and
 * that is fine: a serial is an identifier, not a count.
 */
export async function mintSerials(itemId: string, count: number): Promise<ToolSerial[]> {
  if (count < 1 || count > 500) {
    throw ApiError.badRequest("mint between 1 and 500 serials at a time");
  }

  const item = await sql<{ id: string }[]>`select id from items where id = ${itemId}`;
  if (!item[0]) throw ApiError.notFound("no such item");

  return sql<ToolSerial[]>`
    insert into tool_serials (item_id, serial_no, minted)
    select ${itemId}, next_tool_serial(), true
      from generate_series(1, ${count})
    returning *
  `;
}

/**
 * The serial list shown on an item (§ the owner's request: "if an item number
 * is added, these running serial numbers should be there").
 */
export async function serialsForItem(itemId: string): Promise<ToolSerial[]> {
  return sql<ToolSerial[]>`
    select * from tool_serials
     where item_id = ${itemId}
     order by created_at, serial_no
  `;
}

export async function getSerial(id: string): Promise<ToolSerial> {
  const rows = await sql<ToolSerial[]>`
    select s.*, i.item_code, i.description
      from tool_serials s
      join items i on i.id = s.item_id
     where s.id = ${id}
  `;
  const serial = rows[0];
  if (!serial) throw ApiError.notFound("no such serial");
  return serial;
}

export async function findBySerialNo(serialNo: string): Promise<ToolSerial | null> {
  const rows = await sql<ToolSerial[]>`
    select s.*, i.item_code, i.description
      from tool_serials s
      join items i on i.id = s.item_id
     where s.serial_no = ${serialNo.trim()}
  `;
  return rows[0] ?? null;
}

/**
 * Edit a serial.
 *
 * Editable on purpose — a crib that already has numbers stencilled on its tools
 * should be able to record those rather than a second set. A hand-typed number
 * sets `minted = false`, which is how a report can tell a sequence number from
 * one somebody chose.
 *
 * The unique index is what refuses a number already on another tool; it
 * surfaces as 23505 and `errors.ts` turns that into a 409.
 */
export async function updateSerial(
  id: string,
  patch: { serial_no?: string; status?: "ACTIVE" | "RETIRED"; note?: string | null },
): Promise<ToolSerial> {
  const current = await getSerial(id);

  const nextNo = patch.serial_no?.trim() ?? current.serial_no;
  if (!nextNo) throw ApiError.badRequest("serial number cannot be blank");

  try {
    const rows = await sql<ToolSerial[]>`
      update tool_serials
         set serial_no = ${nextNo},
             minted    = ${nextNo === current.serial_no ? current.minted : false},
             status    = ${patch.status ?? current.status},
             note      = ${patch.note === undefined ? current.note : patch.note}
       where id = ${id}
       returning *
    `;
    return rows[0];
  } catch (e) {
    // The unique index is the real guard — checking first would still race two
    // storekeepers typing the same number. Catching it here is only about the
    // sentence the screen shows.
    if ((e as { code?: string }).code === "23505") {
      const owner = await sql<{ item_code: string }[]>`
        select i.item_code from tool_serials s
          join items i on i.id = s.item_id
         where s.serial_no = ${nextNo}
      `;
      throw ApiError.conflict(
        "SERIAL_TAKEN",
        owner[0]
          ? `${nextNo} is already on a ${owner[0].item_code}.`
          : `${nextNo} is already assigned to another tool.`,
      );
    }
    throw e;
  }
}

/**
 * Record that a sticker was produced.
 *
 * A replacement sticker is the same number printed again — `print_count` goes
 * up, no new row, no new number. That is the difference between reprinting a
 * label and relabelling a tool.
 */
export async function recordPrint(id: string, copies: number): Promise<ToolSerial> {
  const rows = await sql<ToolSerial[]>`
    update tool_serials
       set print_count      = print_count + ${copies},
           first_printed_at = coalesce(first_printed_at, now()),
           last_printed_at  = now()
     where id = ${id}
     returning *
  `;
  const serial = rows[0];
  if (!serial) throw ApiError.notFound("no such serial");
  return serial;
}

export interface PrinterSettings {
  mode: "BROWSER_PDF" | "LAN_AGENT";
  name: string | null;
  host: string | null;
  port: number;
  dpi: number;
  label_width_mm: string;
  label_height_mm: string;
  last_seen_at: Date | null;
}

export async function getPrinterSettings(): Promise<PrinterSettings> {
  const rows = await sql<PrinterSettings[]>`
    select mode, name, host, port, dpi,
           label_width_mm::text as label_width_mm,
           label_height_mm::text as label_height_mm,
           last_seen_at
      from printer_settings where id
  `;
  return rows[0];
}

export async function updatePrinterSettings(
  patch: Partial<Omit<PrinterSettings, "last_seen_at">>,
): Promise<PrinterSettings> {
  const current = await getPrinterSettings();
  const next = { ...current, ...patch };

  // The database enforces this too, but refusing here gives the settings screen
  // a sentence rather than a constraint name.
  if (next.mode === "LAN_AGENT" && !next.host?.trim()) {
    throw ApiError.badRequest("A LAN printer needs an IP address or hostname.");
  }

  await sql`
    update printer_settings
       set mode = ${next.mode}, name = ${next.name}, host = ${next.host},
           port = ${next.port}, dpi = ${next.dpi},
           label_width_mm = ${next.label_width_mm},
           label_height_mm = ${next.label_height_mm},
           updated_at = now()
     where id
  `;
  return getPrinterSettings();
}

/**
 * Queue a print job.
 *
 * BROWSER_PDF jobs are recorded and immediately DONE — the browser is doing the
 * printing and there is nothing to poll for. LAN_AGENT jobs stay QUEUED until
 * an agent inside the plant picks them up, because nothing in Vercel's cloud
 * can reach a printer on a private network.
 */
export async function queuePrintJob(args: {
  serialId?: string | null;
  itemId?: string | null;
  copies: number;
  kind: "SERIAL_QR" | "BIN_LABEL";
  requestedBy: string;
}): Promise<{ id: string; status: string; mode: string }> {
  const printer = await getPrinterSettings();
  const immediate = printer.mode === "BROWSER_PDF";

  const rows = await sql<{ id: string; status: string }[]>`
    insert into print_jobs (serial_id, item_id, copies, kind, status, requested_by, done_at)
    values (${args.serialId ?? null}, ${args.itemId ?? null}, ${args.copies},
            ${args.kind}, ${immediate ? "DONE" : "QUEUED"}, ${args.requestedBy},
            ${immediate ? sql`now()` : null})
    returning id, status
  `;

  return { ...rows[0], mode: printer.mode };
}
