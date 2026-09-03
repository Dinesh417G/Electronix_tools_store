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

import type { ReactNode } from "react";

/** Tone for the number on the right. */
type Tone = "plain" | "out" | "in" | "low" | "empty";

const TONES: Record<Tone, string> = {
  plain: "text-slate-100",
  out: "text-red-400",
  in: "text-emerald-400",
  low: "text-amber-300",
  empty: "text-red-400",
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
    <div className="divide-y divide-slate-800/60 overflow-hidden rounded-xl bg-slate-900">
      {children}
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
    <>
      <div className="flex items-center gap-2">
        <span className="truncate font-semibold">{title}</span>
        {badge}
      </div>
      {subtitle && <div className="truncate text-sm text-slate-400">{subtitle}</div>}
      {meta && <div className="truncate text-xs text-slate-500">{meta}</div>}
    </>
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
          <div className="shrink-0 text-right">
            <div className={`text-lg font-bold tabular-nums ${TONES[tone]}`}>{value}</div>
            {valueNote && (
              <div className="text-xs tabular-nums text-slate-500">{valueNote}</div>
            )}
          </div>
        )}
        {trailing}
      </div>
      {actions && <div className="flex flex-wrap gap-2 px-4 pb-3">{actions}</div>}
    </div>
  );
}
