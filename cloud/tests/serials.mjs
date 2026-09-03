// Running serials, the label batch, and the printer settings — every write
// path that ends in a sticker.
//
// None of them had a test. `route-smoke.mjs` asks the three GETs and stops;
// `label-roundtrip.mjs` proves `qrPng()` encodes what a reader decodes, which
// is the *rendering* and not the route. So the rule §6 states in as many
// words —
//
//   > Reprinting is the same number again: print_count increments, no new
//   > row, no new number.
//
// — was enforced by one `update` in `serials.ts` that nothing exercised. A
// reprint that mints instead of reprinting gives one physical tool two
// identities, and the crib finds out when two stickers on two shelves claim to
// be the same drill.
//
// The other three claims here are the same shape — stated in a comment,
// checked by nothing:
//
//   * A hand-typed number sets `minted = false`, which is how a report tells a
//     sequence number from one somebody chose. Editing anything *else* must
//     leave that flag alone.
//   * `tool_serials.serial_no` is unique across the whole crib, and the route
//     turns 23505 into a sentence naming the tool already holding it.
//   * BROWSER_PDF jobs are recorded DONE with a sheet to open; LAN_AGENT jobs
//     stay QUEUED, because nothing in Vercel's cloud can reach a printer on a
//     private network. This flips the mode through `PUT /admin/printer` and
//     checks both, which is also the only test of that endpoint.
//
// It follows the sheet URL the print route hands back, so the wire is checked
// end to end: a print that returns a link to a page that will not render is a
// storekeeper standing at a printer with nothing to print.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/serials.mjs

import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false, connect_timeout: 20 });

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };
const step = (n) => console.log("\n" + n);

const minted = [];
async function mint(operatorId) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, operator_id, expires_at)
    values (${hash}, 'OPERATOR', ${operatorId}, now() + interval '1 hour')`;
  minted.push(hash);
  return token;
}

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, type: res.headers.get("content-type") ?? "" };
}

const bearer = (t) => ({ Authorization: "Bearer " + t, "Content-Type": "application/json" });

const tag = randomBytes(3).toString("hex").toUpperCase();
// Milliseconds, not `String(date)`. A JS Date stringifies to second
// resolution, so two prints a few hundred milliseconds apart compare equal and
// a first_printed_at that moved looks like one that held.
const ms = (d) => (d === null || d === undefined ? null : new Date(d).getTime());
const serialRow = async (id) => (await sql`
  select serial_no, minted, status, note, print_count,
         first_printed_at, last_printed_at
    from tool_serials where id = ${id}`)[0];

const createdItems = [];
const createdSerials = [];
let printerSnapshot = null;

try {
  step("0. fixtures");
  const [admin] = await sql`
    select id, emp_code from operators where active and role = 'ADMIN' order by emp_code limit 1`;
  const [keeper] = await sql`
    select id, emp_code from operators where active and role = 'STOREKEEPER' order by emp_code limit 1`;
  const [operator] = await sql`
    select id, emp_code from operators where active and role = 'OPERATOR' order by emp_code limit 1`;
  if (!admin || !keeper || !operator) {
    bad("need an active ADMIN, STOREKEEPER and OPERATOR — run the seed first");
    throw new Error("fixtures");
  }
  const adminToken = await mint(admin.id);
  const keeperToken = await mint(keeper.id);
  const operatorToken = await mint(operator.id);

  printerSnapshot = (await sql`
    select mode, name, host, port, dpi,
           label_width_mm::text as label_width_mm,
           label_height_mm::text as label_height_mm, sheet_paper
      from printer_settings where id`)[0];
  ok("printer is in " + printerSnapshot.mode + " mode; it will be put back");

  // Two items of our own, so nothing here touches a seeded row's serials.
  for (const suffix of ["A", "B"]) {
    const made = await call("/api/v1/admin/items", {
      method: "POST",
      headers: bearer(keeperToken),
      body: JSON.stringify({
        item_code: `ZZ-SER-${tag}-${suffix}`,
        description: `Serial test tool ${suffix}`,
        uom: "NOS",
        bin_location: "S-0" + suffix,
        reorder_level: "0",
        allow_negative: false,
      }),
    });
    if (made.status !== 201) {
      bad("could not create the fixture item: " + made.status + " " + JSON.stringify(made.body));
      throw new Error("fixtures");
    }
    createdItems.push(made.body.id);
  }
  const [itemA, itemB] = createdItems;
  ok("two fixture items created");

  step("1. minting takes numbers from the sequence");
  const [{ prefix, pad_width }] = await sql`select prefix, pad_width from serial_settings where id`;
  const mintRes = await call(`/api/v1/items/${itemA}/serials`, {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify({ count: 3 }),
  });
  if (mintRes.status === 201 && Array.isArray(mintRes.body) && mintRes.body.length === 3) {
    ok("201 with three serials");
  } else {
    bad("mint answered " + mintRes.status + " " + JSON.stringify(mintRes.body));
    throw new Error("nothing to work with");
  }
  for (const s of mintRes.body) createdSerials.push(s.id);
  const numbers = mintRes.body.map((s) => s.serial_no);

  const shape = new RegExp(`^${prefix}\\d{${pad_width}}$`);
  if (numbers.every((n) => shape.test(n))) ok(`all three match ${prefix}${"0".repeat(pad_width)}`);
  else bad("numbers are " + numbers.join(", "));
  if (new Set(numbers).size === 3) ok("all three are distinct");
  else bad("duplicate numbers: " + numbers.join(", "));
  if (mintRes.body.every((s) => s.minted === true)) ok("minted = true — these came from the sequence");
  else bad("minted flags: " + mintRes.body.map((s) => s.minted).join(", "));
  if (mintRes.body.every((s) => s.print_count === 0 && s.first_printed_at === null)) {
    ok("nothing is printed yet");
  } else {
    bad("a fresh serial already claims to have been printed");
  }

  const listed = await call(`/api/v1/items/${itemA}/serials`, { headers: bearer(operatorToken) });
  if (listed.status === 200 && listed.body.length === 3) ok("the item lists its three serials");
  else bad("GET serials answered " + listed.status + " with " + (listed.body?.length ?? "?"));

  step("2. minting has bounds, and a role gate");
  const zero = await call(`/api/v1/items/${itemA}/serials`, {
    method: "POST", headers: bearer(keeperToken), body: JSON.stringify({ count: 0 }),
  });
  if (zero.status === 400) ok("count 0 is 400");
  else bad("count 0 answered " + zero.status);

  const tooMany = await call(`/api/v1/items/${itemA}/serials`, {
    method: "POST", headers: bearer(keeperToken), body: JSON.stringify({ count: 501 }),
  });
  if (tooMany.status === 400) ok("count 501 is 400");
  else bad("count 501 answered " + tooMany.status);

  const unknownItem = await call(`/api/v1/items/${randomUUID()}/serials`, {
    method: "POST", headers: bearer(keeperToken), body: JSON.stringify({ count: 1 }),
  });
  if (unknownItem.status === 404) ok("minting for an unknown item is 404");
  else bad("it answered " + unknownItem.status);

  const refusedMint = await call(`/api/v1/items/${itemA}/serials`, {
    method: "POST", headers: bearer(operatorToken), body: JSON.stringify({ count: 1 }),
  });
  if (refusedMint.status === 403) ok("an OPERATOR cannot mint");
  else bad("an OPERATOR token answered " + refusedMint.status);

  step("3. a hand-typed number stops being a minted one");
  const target = mintRes.body[0];
  const stencilled = `SHOP-${tag}-77`;
  const renamed = await call(`/api/v1/serials/${target.id}`, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({ serial_no: stencilled }),
  });
  if (renamed.status === 200) ok("200");
  else bad("PATCH answered " + renamed.status + " " + JSON.stringify(renamed.body));
  let row = await serialRow(target.id);
  if (row.serial_no === stencilled) ok("the number is what the crib already stencils");
  else bad("serial_no is " + row.serial_no);
  if (row.minted === false) ok("minted = false — a report can tell the two apart");
  else bad("minted is still true after a hand edit");

  step("4. editing anything else leaves that flag alone");
  // The branch is `nextNo === current.serial_no ? current.minted : false`, and
  // it is the difference between "somebody chose this number" and "somebody
  // wrote a note on it".
  const stillMinted = mintRes.body[1];
  const noted = await call(`/api/v1/serials/${stillMinted.id}`, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({ note: "second shelf", status: "RETIRED" }),
  });
  if (noted.status === 200) ok("200");
  else bad("PATCH answered " + noted.status + " " + JSON.stringify(noted.body));
  row = await serialRow(stillMinted.id);
  if (row.minted === true) ok("minted stayed true — a note is not a renumbering");
  else bad("writing a note flipped minted to false");
  if (row.serial_no === stillMinted.serial_no) ok("and the number did not move");
  else bad("serial_no changed to " + row.serial_no);
  if (row.status === "RETIRED" && row.note === "second shelf") ok("status and note took");
  else bad("row reads " + JSON.stringify(row));

  const kept = await call(`/api/v1/serials/${stillMinted.id}`, {
    method: "PATCH", headers: bearer(keeperToken), body: JSON.stringify({ status: "ACTIVE" }),
  });
  row = await serialRow(stillMinted.id);
  if (kept.status === 200 && row.note === "second shelf") ok("an omitted note keeps its value");
  else bad("note is " + JSON.stringify(row.note));
  const cleared = await call(`/api/v1/serials/${stillMinted.id}`, {
    method: "PATCH", headers: bearer(keeperToken), body: JSON.stringify({ note: null }),
  });
  row = await serialRow(stillMinted.id);
  if (cleared.status === 200 && row.note === null) ok("an explicit null clears it");
  else bad("note is " + JSON.stringify(row.note));

  step("5. a number can never be on two tools");
  const collide = await call(`/api/v1/serials/${mintRes.body[2].id}`, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({ serial_no: stencilled }),
  });
  if (collide.status === 409 && collide.body?.error === "SERIAL_TAKEN") ok("409 SERIAL_TAKEN");
  else bad("a taken number answered " + collide.status + " " + JSON.stringify(collide.body));
  if (String(collide.body?.message ?? "").includes(`ZZ-SER-${tag}-A`)) {
    ok("the message names the tool already carrying it");
  } else {
    bad("the message is " + JSON.stringify(collide.body?.message));
  }
  row = await serialRow(mintRes.body[2].id);
  if (row.serial_no === mintRes.body[2].serial_no) ok("the refused edit changed nothing");
  else bad("serial_no is now " + row.serial_no);

  const unknownSerial = await call(`/api/v1/serials/${randomUUID()}`, {
    method: "PATCH", headers: bearer(keeperToken), body: JSON.stringify({ status: "RETIRED" }),
  });
  if (unknownSerial.status === 404) ok("PATCH on an unknown serial is 404");
  else bad("it answered " + unknownSerial.status);

  const refusedEdit = await call(`/api/v1/serials/${target.id}`, {
    method: "PATCH", headers: bearer(operatorToken), body: JSON.stringify({ status: "RETIRED" }),
  });
  if (refusedEdit.status === 403) ok("an OPERATOR cannot edit a serial");
  else bad("an OPERATOR token answered " + refusedEdit.status);

  step("6. printing, in BROWSER_PDF mode");
  const toBrowser = await call("/api/v1/admin/printer", {
    method: "PUT",
    headers: bearer(adminToken),
    body: JSON.stringify({ mode: "BROWSER_PDF" }),
  });
  if (toBrowser.status === 200 && toBrowser.body?.mode === "BROWSER_PDF") ok("printer set to BROWSER_PDF");
  else bad("PUT printer answered " + toBrowser.status + " " + JSON.stringify(toBrowser.body));

  const printed = await call(`/api/v1/serials/${target.id}/print`, {
    method: "POST", headers: bearer(keeperToken), body: JSON.stringify({ copies: 2 }),
  });
  if (printed.status === 200) ok("200");
  else bad("print answered " + printed.status + " " + JSON.stringify(printed.body));
  if (printed.body?.status === "DONE") ok("the job is DONE — the browser is doing the printing");
  else bad("job status is " + printed.body?.status);
  if (printed.body?.sheet_url) ok("and it hands back a sheet to open");
  else bad("sheet_url is " + JSON.stringify(printed.body?.sheet_url));

  row = await serialRow(target.id);
  if (row.print_count === 2) ok("print_count = 2");
  else bad("print_count is " + row.print_count);
  if (row.first_printed_at && row.last_printed_at) ok("both timestamps set");
  else bad("timestamps are " + JSON.stringify([row.first_printed_at, row.last_printed_at]));
  const firstPrintedAt = row.first_printed_at;

  const [job] = await sql`
    select kind, copies, status, requested_by from print_jobs
     where serial_id = ${target.id} order by created_at desc limit 1`;
  if (job?.kind === "SERIAL_QR" && job.copies === 2) ok("a SERIAL_QR job was recorded");
  else bad("print_jobs row is " + JSON.stringify(job));
  if (job?.requested_by === keeper.id) ok("recorded against the storekeeper who asked");
  else bad("requested_by is " + job?.requested_by);

  // The sheet the caller was told to open must actually render, and carry the
  // number. A link to a blank page is a storekeeper at a printer with nothing.
  const sheet = await call(printed.body.sheet_url, { headers: bearer(keeperToken) });
  if (sheet.status === 200 && sheet.type.includes("text/html")) ok("the sheet renders as HTML");
  else bad("the sheet answered " + sheet.status + " " + sheet.type);
  if (sheet.text.includes(stencilled)) ok("and carries the serial number");
  else bad("the sheet does not contain " + stencilled);

  step("7. a reprint is the same number again — §6's rule");
  const beforeRows = await sql`select count(*)::int as n from tool_serials where item_id = ${itemA}`;
  const reprint = await call(`/api/v1/serials/${target.id}/print`, {
    method: "POST", headers: bearer(keeperToken), body: JSON.stringify({ copies: 1 }),
  });
  if (reprint.status === 200) ok("200");
  else bad("reprint answered " + reprint.status + " " + JSON.stringify(reprint.body));

  const afterRows = await sql`select count(*)::int as n from tool_serials where item_id = ${itemA}`;
  if (afterRows[0].n === beforeRows[0].n) ok("no new tool_serials row");
  else bad(afterRows[0].n - beforeRows[0].n + " new serial row(s) — a reprint minted a number");

  row = await serialRow(target.id);
  if (row.serial_no === stencilled) ok("no new number");
  else bad("the number changed to " + row.serial_no);
  if (row.print_count === 3) ok("print_count 2 → 3");
  else bad("print_count is " + row.print_count);
  if (ms(row.first_printed_at) === ms(firstPrintedAt)) ok("first_printed_at is still the first");
  else bad("first_printed_at moved to " + row.first_printed_at);
  if (ms(row.last_printed_at) > ms(firstPrintedAt)) ok("last_printed_at moved");
  else bad("last_printed_at did not move: " + row.last_printed_at);

  const badCopies = await call(`/api/v1/serials/${target.id}/print`, {
    method: "POST", headers: bearer(keeperToken), body: JSON.stringify({ copies: 51 }),
  });
  if (badCopies.status === 400) ok("51 copies is 400 — a mis-typed count is a roll of stock");
  else bad("51 copies answered " + badCopies.status);

  const printUnknown = await call(`/api/v1/serials/${randomUUID()}/print`, {
    method: "POST", headers: bearer(keeperToken), body: JSON.stringify({ copies: 1 }),
  });
  if (printUnknown.status === 404) ok("printing an unknown serial is 404");
  else bad("it answered " + printUnknown.status);

  step("8. in LAN_AGENT mode the job waits for something inside the plant");
  const toAgent = await call("/api/v1/admin/printer", {
    method: "PUT",
    headers: bearer(adminToken),
    body: JSON.stringify({ mode: "LAN_AGENT", host: "192.0.2.50", port: 9100 }),
  });
  if (toAgent.status === 200 && toAgent.body?.mode === "LAN_AGENT") ok("printer set to LAN_AGENT");
  else bad("PUT printer answered " + toAgent.status + " " + JSON.stringify(toAgent.body));

  const queued = await call(`/api/v1/serials/${target.id}/print`, {
    method: "POST", headers: bearer(keeperToken), body: JSON.stringify({ copies: 1 }),
  });
  if (queued.body?.status === "QUEUED") ok("the job is QUEUED");
  else bad("job status is " + queued.body?.status);
  if (queued.body?.sheet_url === null) ok("and there is no sheet — the agent prints it");
  else bad("sheet_url is " + JSON.stringify(queued.body?.sheet_url));

  const noHost = await call("/api/v1/admin/printer", {
    method: "PUT",
    headers: bearer(adminToken),
    body: JSON.stringify({ mode: "LAN_AGENT", host: "  " }),
  });
  if (noHost.status === 400) ok("a LAN printer with no address is 400");
  else bad("it answered " + noHost.status + " " + JSON.stringify(noHost.body));
  if (/needs an IP address or hostname/i.test(JSON.stringify(noHost.body ?? ""))) {
    ok("with a sentence rather than a constraint name");
  } else {
    bad("the message is " + JSON.stringify(noHost.body));
  }

  step("9. the printer is an ADMIN setting, though a storekeeper may read it");
  const keeperReads = await call("/api/v1/admin/printer", { headers: bearer(keeperToken) });
  if (keeperReads.status === 200) ok("STOREKEEPER can GET it");
  else bad("GET answered " + keeperReads.status);
  const keeperWrites = await call("/api/v1/admin/printer", {
    method: "PUT", headers: bearer(keeperToken), body: JSON.stringify({ dpi: 600 }),
  });
  if (keeperWrites.status === 403) ok("STOREKEEPER cannot PUT it");
  else bad("a storekeeper's PUT answered " + keeperWrites.status);

  step("10. the bin-label batch");
  await call("/api/v1/admin/printer", {
    method: "PUT", headers: bearer(adminToken), body: JSON.stringify({ mode: "BROWSER_PDF" }),
  });
  const batch = await call("/api/v1/admin/labels/print", {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify({ item_ids: [itemA, itemB], copies: 2, paper: "A4" }),
  });
  if (batch.status === 200 && batch.type.includes("text/html")) ok("200 text/html");
  else bad("labels/print answered " + batch.status + " " + batch.type);
  if (batch.text.includes(`ZZ-SER-${tag}-A`) && batch.text.includes(`ZZ-SER-${tag}-B`)) {
    ok("the sheet carries both item codes");
  } else {
    bad("the sheet is missing one of the item codes");
  }

  // The route logs each job through a `.catch(() => {})`, so a failure here is
  // silent by construction: "who printed what" is a claim only this assertion
  // checks.
  const binJobs = await sql`
    select item_id, copies, kind from print_jobs
     where item_id = any(${[itemA, itemB]}::uuid[]) and kind = 'BIN_LABEL'`;
  if (binJobs.length === 2 && binJobs.every((j) => j.copies === 2)) {
    ok("one BIN_LABEL job recorded per item");
  } else {
    bad("print_jobs holds " + JSON.stringify(binJobs));
  }

  const overCap = await call("/api/v1/admin/labels/print", {
    method: "POST",
    headers: bearer(keeperToken),
    // 20 items × 30 copies = 600 labels, past §11's cap of 500.
    body: JSON.stringify({
      item_ids: (await sql`select id from items limit 20`).map((r) => r.id),
      copies: 30,
    }),
  });
  if (overCap.status === 400) ok("600 labels is 400");
  else bad("over the cap answered " + overCap.status + " " + JSON.stringify(overCap.body));

  const noSuchItems = await call("/api/v1/admin/labels/print", {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify({ item_ids: [randomUUID()], copies: 1 }),
  });
  if (noSuchItems.status === 404) ok("a batch of items that do not exist is 404");
  else bad("it answered " + noSuchItems.status);

  const refusedBatch = await call("/api/v1/admin/labels/print", {
    method: "POST",
    headers: bearer(operatorToken),
    body: JSON.stringify({ item_ids: [itemA], copies: 1 }),
  });
  if (refusedBatch.status === 403) ok("an OPERATOR cannot print a label batch");
  else bad("an OPERATOR token answered " + refusedBatch.status);
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  if (printerSnapshot) {
    await sql`
      update printer_settings
         set mode = ${printerSnapshot.mode}, name = ${printerSnapshot.name},
             host = ${printerSnapshot.host}, port = ${printerSnapshot.port},
             dpi = ${printerSnapshot.dpi},
             label_width_mm = ${printerSnapshot.label_width_mm},
             label_height_mm = ${printerSnapshot.label_height_mm},
             sheet_paper = ${printerSnapshot.sheet_paper}
       where id`;
  }
  if (createdItems.length) {
    // print_jobs cascades from both, tool_serials restricts on items, so the
    // serials go before the items they hang off.
    await sql`delete from print_jobs where item_id = any(${createdItems}::uuid[])`;
    await sql`delete from tool_serials where item_id = any(${createdItems}::uuid[])`;
    await sql`delete from items where id = any(${createdItems}::uuid[])`;
  }
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
