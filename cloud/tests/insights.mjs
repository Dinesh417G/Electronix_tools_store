// The six catalog views, the machine drill-down, and who took what.
//
// These are the questions a storekeeper asks out loud and the console could not
// answer: what does this crib actually get through, what has sat in a bin since
// March, which tools is CNC-L1 eating, who has been signing in.
//
// Every one is a read of the ledger rather than a column somebody maintains,
// which is the only way they can stay true — §7 already says the ledger is the
// truth about movement, and a second store of "times taken" would drift from it
// the first time anybody forgot to update it.
//
// The assertions are about **ordering and membership**, not about exact
// numbers, because the fixture builds its own history and the seed's does not
// need to be pinned. A view that returns rows in the wrong order is the failure
// mode that matters: it is invisible, and it sends somebody to the wrong bin.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/insights.mjs

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

async function get(path, token) {
  const res = await fetch(BASE + path, { headers: { Authorization: "Bearer " + token } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const codes = (rows) => rows.map((r) => r.item_code);
const created = [];

try {
  step("0. three items with histories this test controls");
  const [admin] = await sql`select id from operators where active and role = 'ADMIN' limit 1`;
  const [machine] = await sql`select id, code from machines where active order by code limit 1`;
  const token = await mint(admin.id);

  const tag = randomBytes(3).toString("hex").toUpperCase();
  const names = { hot: `ZZHOT-${tag}`, cold: `ZZCOLD-${tag}`, fresh: `ZZNEW-${tag}` };

  for (const code of Object.values(names)) {
    const [row] = await sql`
      insert into items (item_code, description, uom, reorder_level)
      values (${code}, ${"Insights fixture " + code}, 'NOS', 5)
      returning id`;
    created.push(row.id);
  }
  // Only two of the three ids are used below, and that is the fixture: the
  // third item is never given a ledger row, because the views have to leave an
  // item that has not moved out of "busiest" and "just taken" while putting it
  // top of "stale".
  const [hot, cold] = created;

  // Opening stock for all three, then histories that differ on purpose.
  for (const id of created) {
    await sql`
      insert into stock_ledger (item_id, delta_qty, txn_type, operator_id, note)
      values (${id}, 500, 'OPENING', ${admin.id}, '[test] insights fixture')`;
  }

  // `hot` goes out repeatedly and *just now* — it must top "frequent".
  //
  // Seconds apart, not hours. The window is the last 100 issues by
  // `created_at`, which is the whole point of it; back-dating these by an hour
  // each put them behind the burst of issues the earlier suites in CI had
  // written moments before, and the fixture fell out of its own window. Locally
  // the demo history was spread over weeks and hid it. The semantics are right —
  // an item genuinely is not in the last hundred if a hundred others came
  // after — so the fixture is what had to change.
  for (let i = 0; i < 12; i += 1) {
    await sql`
      insert into stock_ledger (item_id, delta_qty, txn_type, operator_id, machine_id,
                                note, created_at, client_txn_uuid)
      values (${hot}, -2, 'ISSUE', ${admin.id}, ${machine.id},
              '[test] insights fixture', now() - make_interval(secs => ${i}), ${randomUUID()})`;
  }
  // `cold` went out once, long ago — it must top "stale" and appear in neither
  // "frequent" nor "recent".
  await sql`
    insert into stock_ledger (item_id, delta_qty, txn_type, operator_id, note,
                              created_at, client_txn_uuid)
    values (${cold}, -1, 'ISSUE', ${admin.id}, '[test] insights fixture',
            now() - interval '200 days', ${randomUUID()})`;
  // `fresh` has never moved at all.
  ok(`${names.hot} issued 12×, ${names.cold} once 200 days ago, ${names.fresh} never`);

  step("1. frequent — ranked inside the last 100 issues");
  const frequent = await get("/api/v1/items/insights?view=frequent&limit=50", token);
  if (frequent.status !== 200) bad(`answered ${frequent.status}`);
  else {
    const list = codes(frequent.body);
    if (list[0] === names.hot) ok(`${names.hot} is first`);
    else bad(`first is ${list[0]}, expected ${names.hot}`);
    if (!list.includes(names.fresh)) ok("an item that never moved is not in it");
    else bad(`${names.fresh} appears in the busiest list having never moved`);
    const row = frequent.body.find((r) => r.item_code === names.hot);
    if (row && row.recent_issues === 12) ok("it counts 12 of the last 100 issues");
    else bad(`recent_issues was ${row?.recent_issues}, expected 12`);
  }

  step("2. stale — nothing in 90 days, longest first");
  const stale = await get("/api/v1/items/insights?view=stale&limit=200", token);
  const staleList = codes(stale.body);
  if (staleList.includes(names.cold)) ok(`${names.cold} is in it`);
  else bad(`${names.cold} missing from the not-moving list`);
  if (staleList.includes(names.fresh)) ok("so is one that never moved at all");
  else bad(`${names.fresh} missing — never issued is the extreme case of not moving`);
  if (!staleList.includes(names.hot)) ok(`${names.hot} is not, because it moved an hour ago`);
  else bad(`${names.hot} is listed as not moving`);

  step("3. recent — most recently issued first");
  const recent = await get("/api/v1/items/insights?view=recent&limit=10", token);
  if (codes(recent.body)[0] === names.hot) ok(`${names.hot} is first`);
  else bad(`first is ${codes(recent.body)[0]}, expected ${names.hot}`);
  if (!codes(recent.body).includes(names.fresh)) ok("an item that never went out is absent");
  else bad(`${names.fresh} appears in "just taken" having never been taken`);

  step("4. newest — by when it was added");
  const newest = await get("/api/v1/items/insights?view=newest&limit=5", token);
  if (codes(newest.body).some((c) => c.startsWith("ZZ"))) {
    ok("the items created a moment ago are at the top");
  } else {
    bad("newest does not contain anything this test just created: " + codes(newest.body).join(", "));
  }

  step("5. low and high are opposite ends of the same measure");
  const low = await get("/api/v1/items/insights?view=low&limit=200", token);
  const high = await get("/api/v1/items/insights?view=high&limit=200", token);
  const lowFirst = low.body[0];
  if (lowFirst && ["EMPTY", "LOW"].includes(lowFirst.alert_state)) {
    ok(`low starts with an ${lowFirst.alert_state} item`);
  } else {
    bad(`low starts with ${lowFirst?.item_code} (${lowFirst?.alert_state})`);
  }
  const highFirst = high.body[0];
  if (highFirst && Number(highFirst.on_hand) > 0) ok("high starts with something in stock");
  else bad(`high starts with ${highFirst?.item_code} at ${highFirst?.on_hand}`);
  if (low.body.length > 0 && high.body.length > 0 && low.body[0].item_code !== high.body[0].item_code) {
    ok("they do not both start with the same item");
  } else {
    bad("low and high lead with the same row");
  }

  step("6. a view nobody defined is refused, not guessed");
  const bogus = await get("/api/v1/items/insights?view=cheapest", token);
  if (bogus.status === 400) ok("400 on an unknown view");
  else bad(`answered ${bogus.status} for view=cheapest`);

  step("7. machine drill-down — which tools, not just how many");
  const usage = await get("/api/v1/reports/machines?from=2020-01-01&to=2030-01-01", token);
  const forMachine = usage.body.find((r) => r.machine_id === machine.id);
  if (forMachine) ok(`${machine.code} appears with ${forMachine.distinct_tools} distinct tools`);
  else bad(`${machine.code} missing from machine usage`);

  const tools = await get(
    `/api/v1/reports/machines?machine_id=${machine.id}&from=2020-01-01&to=2030-01-01`,
    token,
  );
  const tool = tools.body.find((t) => t.item_code === names.hot);
  if (tool && Number(tool.qty) === 24) ok(`${names.hot} shows 24 consumed on ${machine.code}`);
  else bad(`${names.hot} on ${machine.code} was ${tool?.qty}, expected 24`);

  const none = await get(
    "/api/v1/reports/machines?machine_id=none&from=2020-01-01&to=2030-01-01",
    token,
  );
  if (none.status === 200) {
    ok("movements with no machine are accounted for rather than dropped (§12.6)");
  } else {
    bad(`machine_id=none answered ${none.status}`);
  }

  step("8. who signed in, and how");
  const people = await get("/api/v1/reports/operators?from=2020-01-01&to=2030-01-01", token);
  if (people.status !== 200) bad(`answered ${people.status}: ${JSON.stringify(people.body)}`);
  else {
    const row = people.body.find((r) => r.operator_id === admin.id);
    if (row) ok(`the admin is listed, having taken ${row.qty}`);
    else bad("the operator who wrote every row above is not in the report");
    const splitAddsUp = people.body.every(
      (r) => r.punch_sessions + r.passkey_sessions + r.pin_sessions === r.sessions,
    );
    if (splitAddsUp) ok("punch + passkey + PIN equals the session count for everybody (§8)");
    else bad("the identity split does not add up to the session count");
  }

  step("9. the fixture cannot tidy its own ledger away, and that is the point");
  try {
    await sql`delete from stock_ledger where item_id = ${hot}`;
    bad("a ledger row was deleted — §7's append-only trigger is not holding");
  } catch (error) {
    if (error?.code === "EL003") {
      ok("§7 refuses to let even this test delete a movement");
    } else {
      bad("delete failed for the wrong reason: " + error?.code);
    }
  }

  step("10. a tablet token cannot read who took what");
  await sql`
    insert into tablets (tablet_id, name) values ('insights-tablet', 'insights test')
    on conflict (tablet_id) do nothing`;
  const tabletToken = randomBytes(32).toString("base64url");
  const tabletHash = createHash("sha256").update(tabletToken).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, tablet_id, expires_at)
    values (${tabletHash}, 'TABLET', 'insights-tablet', now() + interval '1 hour')`;
  minted.push(tabletHash);

  const refused = await get("/api/v1/reports/operators", tabletToken);
  if (refused.status === 403) ok("403 — named people are the storekeeper's business");
  else bad(`a tablet token answered ${refused.status} on the operator report`);

  const allowed = await get("/api/v1/items/insights?view=frequent&limit=5", tabletToken);
  if (allowed.status === 200) ok("but the terminal can still ask what moves — same endpoint (§12.4)");
  else bad(`a tablet token answered ${allowed.status} on item insights`);
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  // The fixture's rows are movements, and §7 has no delete — the trigger
  // refuses this test exactly as it refuses the console. So the items retire
  // the way a real one does, `active = false`, which also takes them out of
  // every view above: `itemInsights` filters on `i.active`, so a later run
  // cannot be polluted by an earlier one.
  for (const id of created) {
    await sql`update items set active = false where id = ${id}`;
  }
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
