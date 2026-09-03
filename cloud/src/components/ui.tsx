// Shared shop-floor UI pieces.
//
// Everything here is sized for §12's operator: oily gloves, no patience, and a
// screen mounted on a wall or held in one hand.

import { useRegisterBack } from "./chrome";
import { useState, type ReactNode } from "react";
import type { ConnectionState } from "../lib/events";
import { getEffectiveTheme, setTheme, type Theme } from "../lib/theme";

export function Screen({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    /* `h-full`, and the shell owns the viewport.
     *
     * This was `min-h-dvh`, which made every screen claim a full viewport of
     * its own — so a screen taller than one scrolled the *page*, its inner
     * `overflow-y-auto` never engaged, and the fixed corner controls floated
     * over the middle of the list. The shell is now a single `h-dvh` column of
     * [content, bar]; a screen fills the content half and scrolls inside it. */
    <div className={`flex h-full min-h-0 flex-col safe-top ${className}`}>{children}</div>
  );
}

export function BigButton({
  children,
  onClick,
  variant = "neutral",
  disabled = false,
  className = "",
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "neutral" | "take-out" | "put-in" | "primary" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  const styles: Record<string, string> = {
    neutral: "bg-surface-2 active:bg-surface-3 text-ink",
    "take-out": "bg-red-700 active:bg-red-800 text-white",
    "put-in": "bg-emerald-700 active:bg-emerald-800 text-white",
    primary: "bg-accent active:bg-sky-700 text-white",
    ghost: "bg-transparent border-2 border-line-strong active:bg-surface-2 text-ink-2",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`tap rounded-2xl px-5 text-xl font-semibold transition-colors disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * The connection pill.
 *
 * A claim screen that has silently gone stale is worse than one that says so,
 * so this is always visible rather than only on failure.
 */
export function ConnectionPill({
  state,
  pending,
}: {
  state: ConnectionState;
  pending: number;
}) {
  const label: Record<ConnectionState, string> = {
    live: "Live",
    connecting: "Connecting",
    offline: "Offline",
  };
  const dot: Record<ConnectionState, string> = {
    live: "bg-success",
    connecting: "bg-warning animate-pulse",
    offline: "bg-danger",
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2.5 w-2.5 rounded-full ${dot[state]}`} />
      <span className="text-muted">{label[state]}</span>
      {pending > 0 && (
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning">
          {pending} queued
        </span>
      )}
    </div>
  );
}

/** A banner that has to be read: stock refusals, closed sessions, LOW alerts. */
export function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: "error" | "warn" | "info" | "success";
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    error: "bg-danger-soft border-danger-line text-danger",
    warn: "bg-warning-soft border-warning-line text-warning",
    info: "bg-accent-soft border-accent-line text-accent",
    success: "bg-success-soft border-success-line text-success",
  };

  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-xl border-2 px-4 py-3 text-base ${tones[tone]}`}
    >
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-lg px-2 py-1 text-sm opacity-70"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

export function AlertChip({ level }: { level: string }) {
  if (level === "OK") return null;
  const styles =
    level === "EMPTY"
      ? "bg-danger-soft text-danger border-danger-line"
      : "bg-warning-soft text-warning border-warning-line";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${styles}`}>
      {level}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-muted">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-line-strong border-t-accent" />
      <span>{label}</span>
    </div>
  );
}

/**
 * Back, bottom left.
 *
 * It used to sit inline at the top of the header, which is where a back control
 * goes on a desktop and the worst place for it on the phone this runs on: a
 * 6.7" screen puts the top-left corner out of thumb reach entirely, so leaving
 * a screen meant a second hand or a shuffle of the grip — with gloves on, next
 * to a machine (§12).
 *
 * Bottom left mirrors the settings gear at bottom right, so the two controls
 * that leave a screen sit in the two corners a thumb owns, and neither is ever
 * where content is being read.
 *
 * `fixed`, so it does not move with a scrolling list; screens that scroll pad
 * their bottom to clear it.
 */
export function Header({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  /* The back action is *declared* here and *drawn* in the bottom bar.
   *
   * It belongs to this screen — every Header already knows where back goes —
   * but a control in the top-left of a 6.7" phone is out of thumb reach, and a
   * floating one in the corner covers whatever scrolls under it. Registering it
   * lets the shell put it in reserved space at the bottom, which is both
   * reachable and incapable of hiding anything. */
  useRegisterBack(onBack);

  return (
    <header className="flex shrink-0 items-center gap-3 px-4 pb-3">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-bold">{title}</h1>
        {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
      </div>
      {right}
    </header>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

/**
 * What the list is not showing.
 *
 * Every list on this console is served with a cap — the ledger 60, the
 * catalog and the stock views 200, the live view 40 — and not one of them
 * said so. A screen showing 60 of four thousand movements, with nothing to
 * suggest there are more, is the same failure §14 keeps returning to: it
 * turns "here is a page" into "here is all of it", and the reader has no way
 * to tell.
 *
 * It says nothing when the list came back short of its cap, because then the
 * page really is everything and a note would be noise. `shown === limit` is
 * the only honest signal available without a count from the server: it means
 * "at least this many", never a total, so the wording promises no number it
 * cannot support.
 */
export function ListCap({
  shown,
  limit,
  children,
}: {
  shown: number;
  limit: number;
  children: ReactNode;
}) {
  if (shown < limit) return null;
  return <p className="pt-2 text-xs text-faint">{children}</p>;
}

/**
 * Where the bin sits in its band: reorder level ← on hand → full.
 *
 * The owner's reference shows a 52-week low/high strip with the price marked
 * on it, and the crib has exactly that shape of fact — §6's `reorder_level`
 * and `max_level` bracket a quantity that means nothing on its own. "2 on
 * hand" is a number; "2, and the reorder mark is at 5" is a decision.
 *
 * The tick is the reorder level, so the eye can see which side of it the fill
 * stops on without reading either figure.
 */
export function BandGauge({
  onHand,
  reorder,
  max,
  caption,
}: {
  onHand: number;
  reorder: number;
  /** §6 leaves this null on plenty of a 90-line catalog. */
  max: number | null;
  caption: string;
}) {
  /* Something has to set the scale. With no maximum, twice the reorder level
     is the honest guess — it puts the mark in the middle and leaves room to
     show stock above it. A bin above its own scale pushes the scale, so the
     fill never runs off the end. */
  const ceiling = Math.max(max ?? reorder * 2, onHand, 1);
  const fill = Math.max(0, Math.min(1, onHand / ceiling));
  const tick = Math.max(0, Math.min(1, reorder / ceiling));

  /* Literal mid shades, not the `warning`/`danger` tokens. Those are tuned to
     be *read* — on a light page they resolve to amber-700 and red-600, deep
     enough for text — and a 4px bar drawn in amber-700 reads as mud. A fill
     needs to be seen against its track, not read against a page, which is the
     same reason TAKE OUT and PUT IN keep their literal colors. */
  const tone =
    onHand <= 0 ? "bg-red-500" : onHand <= reorder ? "bg-amber-500" : "bg-emerald-500";

  return (
    /* `mt-1`: stacked on a phone this sits directly under the description, and
       with no gap a 4px bar hard against a line of text reads as an underline
       of that text rather than as a gauge of its own. */
    <span className="mt-1 block">
      <span className="relative block h-1 w-full overflow-hidden rounded-full bg-surface-3">
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${tone}`}
          style={{ width: `${fill * 100}%` }}
        />
        {reorder > 0 && (
          <span
            className="absolute inset-y-0 w-px bg-ink-2"
            style={{ left: `${tick * 100}%` }}
            aria-hidden="true"
          />
        )}
      </span>
      <span className="block pt-0.5 tabular-nums">{caption}</span>
    </span>
  );
}

/**
 * A section nav, underlined rather than filled.
 *
 * Six admin tabs at equal visual weight to "Confirm" or "+ Item" is what made
 * the console read as a stack of identical blue blocks — a reader cannot tell
 * "where I am in the app" from "the button I am about to press" when both are
 * drawn the same way. An underline costs one border and no fill, so the tab a
 * reader is standing on is legible without competing with the controls inside
 * it.
 *
 * Admin-only (`tap-sm` is hardcoded, not the ambient `.tap`), and a single
 * scrolling row rather than the two-row grid it replaces: six labels do not
 * fit a 390 px phone at a readable size either way, and a horizontal strip is
 * the shape every reader already knows from a browser's own tab bar.
 */
export function TabStrip<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
}) {
  return (
    <nav
      className="flex gap-1 overflow-x-auto border-b border-line px-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Section"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-current={value === opt.value ? "page" : undefined}
          className={`tap-sm shrink-0 border-b-2 px-3 text-sm font-semibold whitespace-nowrap ${
            value === opt.value
              ? "border-accent text-accent"
              : "border-transparent text-muted active:bg-surface-2"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * A filter pill: outlined, not filled — the weight one step below `TabStrip`.
 *
 * These select a view of the same list (Busiest / Low / Just taken, a report
 * grouping, a ledger reason) rather than a different screen, and were drawn
 * exactly like `TabStrip`'s tabs and `BigButton`'s primary action: the same
 * solid fill at every level of the hierarchy is what made the console read as
 * one undifferentiated stack of blocks. An unselected chip is a border on the
 * page background; a selected one tints rather than fills, so it reads as
 * "chosen" without shouting louder than the section nav above it.
 */
export function Chip({
  active,
  onClick,
  children,
  title,
  size = "md",
  className = "",
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  /** `sm` for a row of four or more, where `md`'s padding would wrap text. */
  size?: "sm" | "md";
  className?: string;
}) {
  const sizing = size === "sm" ? "px-1.5 text-xs" : "px-3 text-sm";
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`tap rounded-lg border font-semibold whitespace-nowrap transition-colors ${sizing} ${
        active
          ? "border-accent-line bg-accent-soft text-accent"
          : "border-line bg-transparent text-muted active:bg-surface-2"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Light or dark, remembered per device (`lib/theme.ts`).
 *
 * Lives in the settings panel rather than floating in the bottom bar: that
 * bar has exactly two controls, one in each corner a thumb owns on a 6.7"
 * phone, and a third one in the middle is the tap a gloved hand makes by
 * accident reaching for either end (`chrome.tsx`). The gear is already
 * labelled Settings; this is a row inside it, not a new corner.
 *
 * Rendered only while its parent panel is open, which is always after
 * hydration — so reading `document` in the initial state is safe here and
 * would not be above the fold.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  // A lazy initializer, not an effect: this only ever mounts after the panel
  // it lives in is opened by a tap, which is always well after hydration — so
  // reading the current theme during render is safe here.
  const [theme, setThemeState] = useState<Theme>(() => getEffectiveTheme());

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => {
        setTheme(next);
        setThemeState(next);
      }}
      className={`tap-sm flex items-center gap-2 rounded-xl px-3 text-sm font-semibold text-ink-2 active:bg-surface-2 ${className}`}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
          <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
        </svg>
      )}
      <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}
