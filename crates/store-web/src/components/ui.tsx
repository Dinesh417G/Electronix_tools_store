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
    <div className={`flex min-h-full flex-col safe-top safe-bottom ${className}`}>
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
    <header className="flex items-center gap-3 px-4 pb-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="tap -ml-2 flex w-12 items-center justify-center rounded-xl text-2xl text-slate-400 active:bg-slate-800"
        >
          ←
        </button>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-bold">{title}</h1>
        {subtitle && <p className="truncate text-sm text-slate-400">{subtitle}</p>}
      </div>
      {right}
    </header>
  );
}
