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
export function RowHeader({
  leading,
  title,
  subtitle,
  meta,
  value,
}: {
  leading?: string;
  title: string;
  subtitle?: string;
  meta?: string;
  value?: string;
}) {
  return (
    /* No border of its own: it goes inside `RowList`, whose `divide-y` already
       draws the line under it. Two borders there read as a double rule. */
    <div className="hidden items-baseline gap-4 bg-surface-2 px-4 py-2 text-[0.65rem] font-semibold tracking-wider text-faint uppercase sm:flex">
      {leading !== undefined && <div className="w-12 shrink-0">{leading}</div>}
      <div className={CELL_TITLE}>{title}</div>
      <div className={CELL_SUBTITLE}>{subtitle}</div>
      <div className={CELL_META}>{meta}</div>
      {value !== undefined && (
        <div className={`shrink-0 text-right ${CELL_VALUE}`}>{value}</div>
      )}
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
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
        {leading}
        {/* A button only when the row does something. A div wrapped in a button
            that does nothing is a target that swallows taps and tells a screen
            reader it is interactive. */}
        {onClick ? (
          /* `block` is not decoration. Inside the console `.admin .tap` sets
             `display: inline-flex`, which beats a one-class utility on
             specificity and lays this button's three stacked lines out side by
             side — the catalog read "EM-20-4F-TIALN EMPTY 2l Eme... B..".
             globals.css carries `.admin .tap.block` for exactly this, from the
             last time it bit; it only works if the markup asks. */
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
        {trailing}
      </div>
      {actions && <div className="flex flex-wrap gap-2 px-4 pb-3">{actions}</div>}
    </div>
  );
}
