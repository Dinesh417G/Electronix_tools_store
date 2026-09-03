// Loading, failed and empty are three different things, and a stock system
// must never draw the last two the same way.
//
// Every panel in the console used to do this:
//
//     api.stock(params).then(setRows).catch(() => setRows([]))
//
// A failed request became an empty list. The Stock, Alerts and Ledger tabs
// swallowed the error entirely and drew "nothing here"; Reports drew *"Nothing
// went out in this period"* — a sentence about the crib — while the fetch that
// would have known had timed out. A storekeeper reading that concludes the shop
// consumed nothing all month. It is the same failure the terminal's offline
// banner was built to avoid: a screen that cannot tell "there is none" from
// "I could not ask".
//
// `useLoadable` keeps the three apart, and `<Loaded>` renders each one
// differently — including a Retry, because the commonest cause is a request
// that has already come back to life by the time anybody reads the message.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { Spinner } from "@/components/ui";

/**
 * The same one-liner nine screens each declare privately. An `OfflineError`
 * already says which failure it was and how long it waited (§12), and an
 * `ApiError` carries the server's own sentence; anything else is a programming
 * mistake and says so verbatim.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export interface Loadable<T> {
  /** The rows, once they have actually arrived. `null` while unknown. */
  data: T | null;
  /** Why the last attempt failed. `null` when it did not. */
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Run `fetcher` on mount and whenever `deps` change, keeping failure separate
 * from emptiness.
 *
 * On failure `data` stays **null** rather than becoming `[]`: there is no
 * answer, and pretending there is one is the bug this exists to stop.
 */
export function useLoadable<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  onError?: (message: string) => void,
): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The deps come from the caller, so they cannot be an array literal here.
  // That is the whole point of a reusable loader, and the alternative — every
  // panel hand-rolling its own fetch/catch — is what produced the bug this
  // file exists to remove.
  // eslint-disable-next-line react-hooks/use-memo, react-hooks/exhaustive-deps
  const run = useCallback(fetcher, deps);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    run()
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = describe(err);
        // The rows are deliberately left as they were — stale figures clearly
        // labelled as stale beat figures replaced by a confident empty list.
        setError(message);
        onError?.(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  // Blanking on a dep change is deliberate and has to be synchronous: figures
  // from the previous grouping must never sit under a new heading while the
  // next request is in flight. `react-hooks/set-state-in-effect` objects to
  // every loader written this way, including the five already in app-shell.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null);
    return reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/**
 * Draw one of the three states.
 *
 * `empty` is only ever shown when the request actually succeeded and came back
 * with nothing.
 */
export function Loaded<T>({
  state,
  empty,
  label = "Loading…",
  children,
}: {
  state: Loadable<T>;
  /** Shown only when the fetch succeeded and returned nothing. */
  empty: ReactNode;
  label?: string;
  children: (data: T) => ReactNode;
}) {
  const isEmpty = Array.isArray(state.data) && state.data.length === 0;

  if (state.loading && state.data === null) return <Spinner label={label} />;

  if (state.error && state.data === null) {
    return (
      <div className="space-y-3 rounded-xl border border-warning-line bg-warning-soft px-4 py-6 text-center">
        <p className="font-semibold text-warning">This did not load.</p>
        <p className="text-sm text-ink-2">{state.error}</p>
        <p className="text-xs text-faint">
          Nothing is wrong with the stock — this screen simply could not ask.
        </p>
        <button
          type="button"
          onClick={state.reload}
          className="tap rounded-xl bg-amber-700 px-5 text-sm font-semibold text-white"
        >
          {state.loading ? "Trying…" : "Try again"}
        </button>
      </div>
    );
  }

  return (
    <>
      {state.error && state.data !== null && (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
          Showing the last figures that loaded — the newest attempt failed. {state.error}{" "}
          <button type="button" onClick={state.reload} className="underline">
            Try again
          </button>
        </p>
      )}
      {isEmpty ? empty : state.data !== null ? children(state.data) : null}
    </>
  );
}
