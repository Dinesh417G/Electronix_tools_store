// One row shape for every list of records in the app.
//
// The owner pointed at a Zerodha watchlist: an identifier on the left, its
// numbers hard right, a quiet second line, hairline dividers, no card borders.
// It reads well because every row is the same shape, so the eye runs down a
// column instead of reading each row as a fresh object.
//
// Ours were five different shapes — the catalog, the stock views, the ledger,
// the browse list and the shortage list each grew their own markup, so the same
// item code sat at a different indent and its quantity in a different weight
// depending on which tab you were looking at.
//
// Slots rather than one rigid layout, because these lists are not all
// read-only: the catalog selects rows for label printing and opens serials, and
// the ledger reverses a movement. A row that could not carry those would push
// them back into bespoke markup, which is what this exists to stop.

// ── One layout, two shapes ──────────────────────────────────────────────
//
// Below `sm:` a row stacks: identifier, then subtitle, then meta, with the
// number hard right. That is the phone shape, and it is what these lists were
// built for.
//
// At `sm:` and up the same slots lay out as *columns*, because the console also
// runs on the server PC (§2), and there it was still a phone: at 1568 px an
// item code sat far left, its quantity far right, and a thousand pixels of
// nothing in between. The Zerodha screener the owner pointed at is a real
// table at that width — a header band, one column per fact, numbers aligned
// down the column.
//
// The cell widths live here, in one place, shared by `Row` and `RowHeader`,
// because a header whose columns do not line up with its rows is worse than no
// header at all. An absent subtitle or meta still holds its column open at
// `sm:` (`hidden sm:block`), or the column below it would wander left on every
// row that happens to be missing one.

import type { ReactNode } from "react";
import type { SortState } from "../lib/paging";

/* Wide enough for the longest thing a crib actually calls a tool —
   `LNMU0303ZER-MP6120` is 18 characters — *plus* its badge. At `w-52` the
   badge kept its width (it does not truncate) and the code gave way, so the
   catalog read "LNMU0303ZER-MP…": the one string on the row you scan for. */
const CELL_TITLE = "sm:w-64 sm:shrink-0";
const CELL_SUBTITLE = "sm:flex-1";
const CELL_META = "sm:w-56 sm:shrink-0";
const CELL_VALUE = "sm:w-28";

/** Tone for the number on the right. */
type Tone = "plain" | "out" | "in" | "low" | "empty";

const TONES: Record<Tone, string> = {
  plain: "text-ink",
  out: "text-danger",
  in: "text-success",
  low: "text-warning",
  empty: "text-danger",
};

/**
 * The container. Dividers, not cards.
 *
 * A card per row spends eight pixels of gap and two of border on every item,
 * which on a phone is most of a row: the shortage list fitted seven items where
 * the same screen now fits eleven. It also gives every row a box the eye has to
 * enter and leave, which is what makes a long list feel like work.
 */
export function RowList({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {children}
    </div>
  );
}

/**
 * Column labels for a `RowList`, on the widths `Row` uses.
 *
 * `sm:` and up only: below that the rows are stacked, so a header would be
 * labelling columns that are not there. `leading` takes the width of whatever
 * the rows put in their own leading slot — pass it only when every row in the
 * list has one, and keep the two widths the same (the ledger's time gutter is
 * `w-12` in both).
 */
/**
 * A header cell: a label, or a label that sorts.
 *
 * A plain string stays plain text, so a column with no server-side ordering
 * behind it cannot accidentally look clickable. Only the ones given a `sort`
 * key become buttons — and only when the list is also given an `onSort`, so a
 * screen that has not wired the state yet renders labels rather than controls
 * that do nothing.
 */
export type HeaderCell<K extends string> = string | { label: string; sort: K };

const label = <K extends string>(cell: HeaderCell<K> | undefined) =>
  typeof cell === "string" ? cell : cell?.label;

/**
 * The column headings, optionally sortable.
 *
 * The sort is applied by the server, over the whole table, and that is the
 * reason this took as long to arrive as it did: a header that reordered the
 * rows already on screen would reorder sixty of four thousand while looking
 * exactly like a ranking of all of them. Wrong, and invisibly so — the worst
 * combination for a screen somebody uses to answer "where did forty inserts
 * go".
 *
 * Tapping the active column flips its direction; tapping another switches to
 * it. The arrow is drawn only on the active one, because an arrow on every
 * column tells the reader nothing about which is in force.
 */
export function RowHeader<K extends string>({
  leading,
  title,
  subtitle,
  meta,
  value,
  sort,
  onSort,
}: {
  leading?: HeaderCell<K>;
  title: HeaderCell<K>;
  subtitle?: HeaderCell<K>;
  meta?: HeaderCell<K>;
  value?: HeaderCell<K>;
  sort?: SortState<K>;
  onSort?: (key: K) => void;
}) {
  const cell = (content: HeaderCell<K> | undefined, className: string) => {
    if (content === undefined) return <div className={className} />;
    if (typeof content === "string" || !onSort) {
      return <div className={className}>{label(content)}</div>;
    }
    const active = sort?.key === content.sort;
    return (
      <div className={className}>
        <button
          type="button"
          onClick={() => onSort(content.sort)}
          aria-label={`Sort by ${content.label}`}
          /* `.admin .tap` is `inline-flex` and beats a single class, so this
             deliberately does not use `tap` — a header control is text-sized,
             not a 3.5rem target. */
          className={`inline-flex items-baseline gap-1 tracking-wider uppercase ${
            active ? "text-ink" : "text-faint hover:text-ink-2"
          }`}
        >
          {content.label}
          {/* Reserved either way, so the label does not shift left when the
              sort moves to another column. */}
          <span aria-hidden className={active ? "" : "opacity-0"}>
            {sort?.dir === "desc" ? "▾" : "▴"}
          </span>
        </button>
      </div>
    );
  };

  return (
    /* No border of its own: it goes inside `RowList`, whose `divide-y` already
       draws the line under it. Two borders there read as a double rule. */
    <div className="hidden items-baseline gap-4 bg-surface-2 px-4 py-2 text-[0.65rem] font-semibold tracking-wider text-faint uppercase sm:flex">
      {leading !== undefined && cell(leading, "w-12 shrink-0")}
      {cell(title, CELL_TITLE)}
      {cell(subtitle, CELL_SUBTITLE)}
      {cell(meta, CELL_META)}
      {value !== undefined && cell(value, `shrink-0 text-right ${CELL_VALUE}`)}
    </div>
  );
}

export function Row({
  title,
  badge,
  subtitle,
  meta,
  value,
  valueNote,
  tone = "plain",
  onClick,
  leading,
  trailing,
  actions,
  detail,
  open = false,
}: {
  title: ReactNode;
  /** Sits beside the title: an alert chip, a "retired" pill. */
  badge?: ReactNode;
  subtitle?: ReactNode;
  /** The third line — bin, reason, why this row is in this list. */
  meta?: ReactNode;
  /** The number. Right-aligned and `tabular-nums`, so columns stack. */
  value?: ReactNode;
  valueNote?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
  /** Before the text: a selection box. */
  leading?: ReactNode;
  /** After the number: a per-row control. */
  trailing?: ReactNode;
  /** Under the row, inside its divider cell: buttons that act on it. */
  actions?: ReactNode;
  /**
   * Detail revealed under the row, in place.
   *
   * The catalog kept every tooling field — ISO code, grade, manufacturer,
   * diameter, flutes, cost — behind a full-page edit form, so comparing two
   * inserts meant in, out, in, out. The ledger was worse: it showed a
   * truncated meta line and offered no route at all to the note, the two
   * clocks, or the reversal chain.
   *
   * Rendering it here rather than navigating is the Zerodha screener's move,
   * and Reports' by-machine panel has done it in this codebase all along.
   */
  detail?: ReactNode;
  /** Whether `detail` is showing. The caller owns which row is open. */
  open?: boolean;
}) {
  const text = (
    <div className="min-w-0 sm:flex sm:items-baseline sm:gap-4">
      <div className={`flex items-center gap-2 ${CELL_TITLE}`}>
        <span className="truncate font-semibold">{title}</span>
        {badge}
      </div>
      <div
        className={`truncate text-sm text-muted ${CELL_SUBTITLE} ${
          subtitle ? "" : "hidden sm:block"
        }`}
      >
        {subtitle}
      </div>
      <div
        className={`truncate text-xs text-faint ${CELL_META} ${meta ? "" : "hidden sm:block"}`}
      >
        {meta}
      </div>
    </div>
  );

  return (
    <div className="group">
      <div className="flex items-center gap-3 px-4 py-3">
        {leading}
        {/* A button only when the row does something. A div wrapped in a button
            that does nothing is a target that swallows taps and tells a screen
            reader it is interactive. */}
        {onClick ? (
          /* `block` was load-bearing and is now belt-and-braces, which is
             worth writing down rather than leaving as folklore.
             `.admin .tap` sets `display: inline-flex`, beating a one-class
             utility on specificity, and it used to lay this button's three
             stacked lines out side by side — the catalog read
             "EM-20-4F-TIALN EMPTY 2l Eme… B..". Since the lines moved into a
             single wrapper (above), the button has one child and inline-flex
             has nothing to spread, so removing `block` changes nothing —
             checked, by removing it and watching the geometry test not care.
             It stays because the day somebody flattens that wrapper again is
             the day it matters, and `globals.css` still carries
             `.admin .tap.block` for it. */
          <button
            type="button"
            onClick={onClick}
            className="tap block min-w-0 flex-1 text-left"
          >
            {text}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{text}</div>
        )}
        {value !== undefined && (
          <div className={`shrink-0 text-right ${CELL_VALUE}`}>
            <div className={`text-lg font-bold tabular-nums ${TONES[tone]}`}>{value}</div>
            {valueNote && (
              <div className="text-xs tabular-nums text-faint">{valueNote}</div>
            )}
          </div>
        )}
        {/* Desktop: the actions ride *in* the row, revealed on hover or on
            keyboard focus, the way the watchlist row in the owner's second
            reference does. Below `sm:` they stay in their own strip under the
            row — there is no hover on a touch screen, and this console is
            used on a phone too.

            `pointer-events-none` while hidden is not decoration: an invisible
            button that still takes clicks is a Reverse waiting to happen.
            Keyboard focus ignores pointer-events, so Tab still reaches them
            and `group-focus-within` brings them back into view. */}
        {actions && (
          <div className="hidden shrink-0 items-center gap-2 opacity-0 transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 sm:flex">
            {actions}
          </div>
        )}
        {trailing}
      </div>
      {actions && (
        <div className="flex flex-wrap gap-2 px-4 pb-3 sm:hidden">{actions}</div>
      )}
      {detail && open && <div className="px-4 pb-4">{detail}</div>}
    </div>
  );
}

/**
 * A group of label/value facts inside a `Row`'s `detail`.
 *
 * Zerodha's expanded row is four of these side by side — Instrument,
 * Fundamentals, Price & volume, Growth — each a titled card of one-line
 * label-left/value-right rows. They wrap to one column on a phone.
 */
export function DetailGroup({
  title,
  facts,
}: {
  title: string;
  facts: Fact[];
}) {
  /* Facts, then groups. A movement with no reason, no note and no cost
     rendered two titled boxes with nothing inside them — an empty box is a
     louder way of saying nothing than leaving the space alone. Both levels
     drop out: the fact when it has no value, the group when no fact survived. */
  const shown = facts.filter(
    (f) => f.value !== null && f.value !== undefined && f.value !== "",
  );
  if (shown.length === 0) return null;

  return (
    <div className="rounded-lg border border-line bg-app/40 p-3">
      <div className="pb-1 text-[0.65rem] font-semibold tracking-wider text-faint uppercase">
        {title}
      </div>
      <dl className="divide-y divide-line">
        {shown.map((f) => (
          <div key={f.label} className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="shrink-0 text-xs text-muted">{f.label}</dt>
            <dd
              className={`min-w-0 truncate text-right text-sm tabular-nums ${
                f.tone ? TONES[f.tone] : "text-ink"
              }`}
            >
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
  tone?: Tone;
}

/** The wrapper the groups sit in: four across on a monitor, one on a phone. */
export function DetailGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  );
}
