// The filter row, and the one line of stock context each view earns.
//
// Shared by the console's Stock tab and the terminal's Browse screen on
// purpose. §12.4 says the scan path and the search path must land on the same
// item card; the same argument applies here. A storekeeper who learns that
// "Busiest" means the last hundred issues should not find the shop-floor
// terminal ranking by something else — two screens quietly disagreeing about
// which tools move most is worse than neither offering the filter.

import type { InsightItem, InsightView } from "@/lib/api";

export const VIEW_LABELS: { value: InsightView; label: string; hint: string }[] = [
  { value: "frequent", label: "Busiest", hint: "most taken in the last 100 issues" },
  { value: "low", label: "Low", hint: "at or below the reorder level" },
  { value: "recent", label: "Just taken", hint: "went out most recently" },
  { value: "stale", label: "Not moving", hint: "no issue in 90 days" },
  { value: "high", label: "Well stocked", hint: "furthest above the reorder level" },
  { value: "newest", label: "New items", hint: "added to the catalog most recently" },
];

export function FilterChips({
  view,
  onChange,
  className = "",
}: {
  view: InsightView;
  onChange: (next: InsightView) => void;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-3 gap-1 ${className}`}>
      {VIEW_LABELS.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={`tap rounded-lg px-2 text-sm font-semibold ${
            view === option.value ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const hintFor = (view: InsightView) =>
  VIEW_LABELS.find((v) => v.value === view)?.hint ?? "";

/**
 * What this row is doing in *this* list.
 *
 * A number without its reason is noise: "12 on hand" says nothing about why an
 * item is in the Busiest list. Each view states the fact it was sorted on, so
 * the ordering is checkable by eye rather than taken on trust.
 */
export function viewDetail(view: InsightView, item: InsightItem): string {
  const days = item.days_since_issue;
  switch (view) {
    case "frequent":
      return item.recent_issues === 0
        ? "not in the last 100 issues"
        : `${item.recent_issues} of the last 100 issues · ${item.recent_qty} taken`;
    case "recent":
      return days === null
        ? "never issued"
        : days === 0
          ? "taken today"
          : days === 1
            ? "taken yesterday"
            : `taken ${days} days ago`;
    case "stale":
      return days === null ? "never issued" : `last issued ${days} days ago`;
    case "newest":
      return `added ${new Date(item.created_at).toLocaleDateString()}`;
    case "high":
      return `${item.on_hand} on hand, keeps ${item.reorder_level}`;
    case "low":
      return `${item.on_hand} on hand, reorder at ${item.reorder_level}`;
  }
}
