// The six questions a storekeeper actually asks a catalog, answered from the
// ledger rather than from a column somebody has to remember to update.
//
// "What moves the most", "what has not moved at all", "what went out this
// week", "what did we just add" — none of these can be stored on `items`
// without inventing a second source of truth that drifts from the ledger the
// moment anybody forgets to maintain it. §7 already says the ledger is the
// truth about movement; these are reads of it.
//
// **`frequent` is deliberately a window, not a counter.** The request was
// "frequently taken, based on the last 100 transactions, kept updated". A
// stored counter would need a trigger, would double-count a reversal unless
// taught not to, and would answer with the whole of history — so a tool that
// was hammered last winter and untouched since would outrank one being taken
// daily. Ranking within the most recent N issues is self-updating by
// construction: the hundred-and-first issue pushes the oldest out, and a
// reversal removes its own row's weight because the reversing row is an ISSUE
// with the opposite sign and is excluded.

import { sql } from "./db.ts";
import type { AlertState } from "./ledger.ts";

/** How many recent issues define "recently". Ranking window for `frequent`. */
export const RECENT_WINDOW = 100;

/** No issue in this many days is "not moving". A quarter of a year. */
export const STALE_DAYS = 90;

export const VIEWS = [
  "newest",
  "high",
  "low",
  "stale",
  "frequent",
  "recent",
] as const;

export type InsightView = (typeof VIEWS)[number];

export function isInsightView(value: string): value is InsightView {
  return (VIEWS as readonly string[]).includes(value);
}

export interface InsightRow {
  id: string;
  item_code: string;
  description: string;
  uom: string;
  bin_location: string | null;
  on_hand: string;
  reorder_level: string;
  max_level: string | null;
  alert_state: AlertState;
  created_at: Date;
  /** Times this item appears in the last `RECENT_WINDOW` issues. */
  recent_issues: number;
  /** Total quantity issued inside that same window. */
  recent_qty: string;
  last_issued_at: Date | null;
  /** Whole days since the last issue. `null` if it has never gone out. */
  days_since_issue: number | null;
}

/**
 * One query, six orderings.
 *
 * The window is computed once as a CTE and joined, so `frequent` and `recent`
 * cost the same as the others: `stock_ledger(created_at desc)` already exists
 * for exactly this shape.
 */
export async function itemInsights(
  view: InsightView,
  limit = 50,
): Promise<InsightRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200);

  // Whitelisted fragments — `view` is checked by `isInsightView` at the route
  // and again by this switch, so nothing user-supplied reaches the ordering.
  const order = {
    // What did we just add to the catalog.
    newest: sql`i.created_at desc, i.item_code`,
    // Plenty on the shelf. Measured against the item's own reorder level, so a
    // bin holding 40 of something we keep 5 of ranks above one holding 60 of
    // something we keep 200 of — "high" is relative to what this item needs.
    high: sql`
      case when i.reorder_level > 0 then coalesce(s.on_hand, 0) / i.reorder_level
           else coalesce(s.on_hand, 0) end desc,
      coalesce(s.on_hand, 0) desc`,
    // Running out. EMPTY before LOW, then closest to the line first.
    low: sql`
      (coalesce(s.alert_state, 'OK') = 'EMPTY') desc,
      (coalesce(s.alert_state, 'OK') = 'LOW') desc,
      coalesce(s.on_hand, 0) asc,
      i.item_code`,
    // Not moving: never issued first, then longest since.
    stale: sql`w.last_issued_at asc nulls first, i.item_code`,
    // Frequently taken, inside the recent window.
    frequent: sql`w.recent_issues desc nulls last, w.recent_qty desc nulls last, i.item_code`,
    // Newly taken out.
    recent: sql`w.last_issued_at desc nulls last, i.item_code`,
  }[view];

  // `stale` and `frequent` are questions about movement, so an item with no
  // movement at all belongs in one and not the other.
  const having =
    view === "frequent"
      ? sql`and coalesce(w.recent_issues, 0) > 0`
      : view === "recent"
        ? sql`and w.last_issued_at is not null`
        : view === "stale"
          ? sql`and (w.last_issued_at is null
                     or w.last_issued_at < now() - make_interval(days => ${STALE_DAYS}))`
          : sql``;

  return sql<InsightRow[]>`
    with recent as (
      -- The last N issues, newest first. A reversing row is an ISSUE with the
      -- opposite sign; counting it as an issue would inflate exactly the items
      -- whose mistakes were corrected.
      select item_id, delta_qty, created_at
        from stock_ledger
       where txn_type = 'ISSUE' and reverses_id is null
       order by created_at desc
       limit ${RECENT_WINDOW}
    ),
    windowed as (
      select i.id as item_id,
             count(r.item_id)::int as recent_issues,
             coalesce(sum(-r.delta_qty), 0)::text as recent_qty,
             (select max(l.created_at) from stock_ledger l
               where l.item_id = i.id and l.txn_type = 'ISSUE' and l.reverses_id is null
             ) as last_issued_at
        from items i
        left join recent r on r.item_id = i.id
       group by i.id
    )
    select i.id, i.item_code, i.description, i.uom, i.bin_location,
           coalesce(s.on_hand, 0)::text as on_hand,
           i.reorder_level::text as reorder_level,
           i.max_level::text as max_level,
           coalesce(s.alert_state, 'OK') as alert_state,
           i.created_at,
           coalesce(w.recent_issues, 0) as recent_issues,
           coalesce(w.recent_qty, '0') as recent_qty,
           w.last_issued_at,
           case when w.last_issued_at is null then null
                else extract(day from now() - w.last_issued_at)::int
           end as days_since_issue
      from items i
      left join item_stock s on s.item_id = i.id
      left join windowed w on w.item_id = i.id
     where i.active ${having}
     order by ${order}
     limit ${capped}
  `;
}

export interface MachineUsageRow {
  machine_id: string | null;
  machine_code: string;
  machine_name: string | null;
  movements: number;
  qty: string;
  value: string;
  distinct_tools: number;
}

export interface MachineToolRow {
  item_id: string;
  item_code: string;
  description: string;
  movements: number;
  qty: string;
  value: string;
  last_issued_at: Date;
}

/**
 * Consumption per machine, and what each machine actually consumed.
 *
 * `/reports/consumption?group_by=machine` already gives the totals. What it
 * cannot answer is the question that follows it — *which tools* is CNC-L1
 * eating — and that is the one that leads somewhere: a machine burning through
 * one insert grade and nothing else is a setup problem, not a stock problem.
 *
 * Rows with no machine recorded are kept and labelled rather than dropped.
 * §12.6 makes the machine optional on purpose, so a report that silently
 * ignored those movements would not add up to the consumption report beside it.
 */
export async function machineUsage(from: Date, to: Date): Promise<MachineUsageRow[]> {
  return sql<MachineUsageRow[]>`
    select l.machine_id,
           coalesce(m.code, 'No machine recorded') as machine_code,
           m.name as machine_name,
           count(*)::int as movements,
           sum(-l.delta_qty)::text as qty,
           coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::text as value,
           count(distinct l.item_id)::int as distinct_tools
      from stock_ledger l
      left join machines m on m.id = l.machine_id
     where l.txn_type in ('ISSUE', 'SCRAP')
       and l.created_at >= ${from} and l.created_at < ${to}
     group by l.machine_id, m.code, m.name
    having sum(-l.delta_qty) <> 0
     order by sum(-l.delta_qty) desc
  `;
}

/** The tools one machine consumed in the window. `null` = movements with none. */
export async function machineTools(
  machineId: string | null,
  from: Date,
  to: Date,
): Promise<MachineToolRow[]> {
  return sql<MachineToolRow[]>`
    select i.id as item_id, i.item_code, i.description,
           count(*)::int as movements,
           sum(-l.delta_qty)::text as qty,
           coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::text as value,
           max(l.created_at) as last_issued_at
      from stock_ledger l
      join items i on i.id = l.item_id
     where l.txn_type in ('ISSUE', 'SCRAP')
       and l.created_at >= ${from} and l.created_at < ${to}
       and ((${machineId}::uuid is null and l.machine_id is null)
            or l.machine_id = ${machineId}::uuid)
     group by i.id, i.item_code, i.description
    having sum(-l.delta_qty) <> 0
     order by sum(-l.delta_qty) desc
  `;
}

export interface OperatorStatRow {
  operator_id: string;
  emp_code: string;
  full_name: string;
  role: string;
  sessions: number;
  punch_sessions: number;
  passkey_sessions: number;
  pin_sessions: number;
  movements: number;
  qty: string;
  value: string;
  last_seen_at: Date | null;
}

/**
 * Who signed in, how, and what they took.
 *
 * The identity split is not decoration. §8 says a punch, a passkey and a typed
 * PIN are not equal evidence, and a report that flattens them into "sessions"
 * throws away the distinction the whole identity design exists to preserve.
 */
export async function operatorStats(from: Date, to: Date): Promise<OperatorStatRow[]> {
  return sql<OperatorStatRow[]>`
    with sessions_in_window as (
      select operator_id,
             count(*)::int as sessions,
             count(*) filter (where identity_source = 'PUNCH')::int as punch_sessions,
             count(*) filter (where identity_source = 'WEBAUTHN')::int as passkey_sessions,
             count(*) filter (where identity_source = 'PIN')::int as pin_sessions,
             max(opened_at) as last_seen_at
        from sessions
       where opened_at >= ${from} and opened_at < ${to}
       group by operator_id
    ),
    taken as (
      select operator_id,
             count(*)::int as movements,
             sum(-delta_qty)::text as qty,
             coalesce(sum(-delta_qty * coalesce(unit_cost, 0)), 0)::text as value
        from stock_ledger
       where txn_type in ('ISSUE', 'SCRAP')
         and created_at >= ${from} and created_at < ${to}
       group by operator_id
    )
    select o.id as operator_id, o.emp_code, o.full_name, o.role,
           coalesce(s.sessions, 0) as sessions,
           coalesce(s.punch_sessions, 0) as punch_sessions,
           coalesce(s.passkey_sessions, 0) as passkey_sessions,
           coalesce(s.pin_sessions, 0) as pin_sessions,
           coalesce(t.movements, 0) as movements,
           coalesce(t.qty, '0') as qty,
           coalesce(t.value, '0') as value,
           s.last_seen_at
      from operators o
      left join sessions_in_window s on s.operator_id = o.id
      left join taken t on t.operator_id = o.id
     where o.active or s.sessions is not null or t.movements is not null
     order by coalesce(t.movements, 0) desc, coalesce(s.sessions, 0) desc, o.emp_code
  `;
}
