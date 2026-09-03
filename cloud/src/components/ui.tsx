// Shared shop-floor UI pieces.
//
// Everything here is sized for §12's operator: oily gloves, no patience, and a
// screen mounted on a wall or held in one hand.

import type { ReactNode } from "react";
import type { ConnectionState } from "../lib/events";

export function Screen({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    /* `min-h-dvh`, not `min-h-full`. A percentage min-height resolves against
       the parent's height, and this sits inside the shell's
       `div.relative.min-h-full` — which has a min-height and no definite
       height, so the percentage resolved to nothing and every Screen collapsed
       to its own content. Measured on the idle screen: 528px inside a 915px
       viewport, which is why `justify-between` had been placing nothing at the
       bottom since the cloud port and the terminal looked half empty. The
       dynamic viewport unit needs no parent chain, and `dvh` rather than `vh`
       so a mobile browser's retracting toolbar does not leave a gap. */
    <div className={`flex min-h-dvh flex-col safe-top safe-bottom ${className}`}>
      {children}
    </div>
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
    neutral: "bg-slate-800 active:bg-slate-700 text-slate-100",
    "take-out": "bg-red-700 active:bg-red-800 text-white",
    "put-in": "bg-emerald-700 active:bg-emerald-800 text-white",
    primary: "bg-sky-600 active:bg-sky-700 text-white",
    ghost: "bg-transparent border-2 border-slate-700 active:bg-slate-800 text-slate-300",
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
    live: "bg-emerald-400",
    connecting: "bg-amber-400 animate-pulse",
    offline: "bg-red-500",
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2.5 w-2.5 rounded-full ${dot[state]}`} />
      <span className="text-slate-400">{label[state]}</span>
      {pending > 0 && (
        <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300">
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
    error: "bg-red-950 border-red-700 text-red-100",
    warn: "bg-amber-950 border-amber-600 text-amber-100",
    info: "bg-sky-950 border-sky-700 text-sky-100",
    success: "bg-emerald-950 border-emerald-700 text-emerald-100",
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
      ? "bg-red-500/20 text-red-300 border-red-600"
      : "bg-amber-500/20 text-amber-300 border-amber-600";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${styles}`}>
      {level}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-slate-400">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-700 border-t-sky-500" />
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
function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back"
      className="tap fixed bottom-3 left-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-slate-800/90 text-slate-300 shadow-lg backdrop-blur safe-bottom active:bg-slate-700"
    >
      {/* An SVG rather than "←". The glyph rendered in whatever the system font
          had, which is why it looked like a character in a sentence rather than
          a control — thin, differently weighted on every device, and unmatched
          to the gear opposite it. This is drawn at a fixed weight everywhere. */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
        aria-hidden="true"
      >
        <path d="M15 5 8 12l7 7" />
      </svg>
    </button>
  );
}

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
  return (
    <>
      <header className="flex items-center gap-3 px-4 pb-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold">{title}</h1>
          {subtitle && <p className="truncate text-sm text-slate-400">{subtitle}</p>}
        </div>
        {right}
      </header>
      {onBack && <BackButton onBack={onBack} />}
    </>
  );
}

/** A labelled form row. Shared by the item form and the printer settings. */
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
      <span className="text-xs font-semibold text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
