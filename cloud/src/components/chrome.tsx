"use client";

// The bottom bar, and the one thing every screen needs to put in it.
//
// Why a bar rather than the two floating buttons it replaces: a `fixed` control
// sits *over* content, and padding only protects the end of a list. Everything
// in the middle of a long one still scrolls underneath — which is how the
// settings gear came to be covering "Serials" in the catalog, a control the
// storekeeper is meant to tap. Five separate paddings were added in one day
// chasing that, each fixing one screen.
//
// Reserved space cannot have the problem. The bar is a flex sibling of the
// screen, not an overlay, so the scrolling region ends where the bar begins and
// nothing can ever be hidden behind it. It is also what the Zerodha layout the
// owner pointed at actually does: a summary strip on top, a bar underneath, and
// the list owning everything between.
//
// `back` reaches it through context because `Header` is a long way down the
// tree from the shell that renders the bar, and every screen already declares
// its own back action there. Registering by id rather than by presence means a
// screen unmounting after its replacement has mounted cannot clear the new
// one's handler.

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface BackRegistration {
  register: (id: string, onBack: (() => void) | null) => void;
}

const BackContext = createContext<BackRegistration>({ register: () => {} });

/** Called by `Header`. A screen with no back action passes nothing. */
export function useRegisterBack(onBack?: () => void): void {
  const { register } = useContext(BackContext);
  const id = useId();

  useEffect(() => {
    register(id, onBack ?? null);
    return () => register(id, null);
  }, [register, id, onBack]);
}

/**
 * Holds whatever the current screen registered, and hands it to the bar.
 *
 * The value is the registration *function*, which never changes identity, so a
 * screen registering does not re-render every other consumer.
 */
export function ChromeProvider({
  children,
}: {
  children: (back: (() => void) | null) => ReactNode;
}) {
  const [entries, setEntries] = useState<Record<string, () => void>>({});

  const register = useMemo(
    () => (id: string, onBack: (() => void) | null) => {
      setEntries((current) => {
        if (onBack === null) {
          if (!(id in current)) return current;
          const next = { ...current };
          delete next[id];
          return next;
        }
        if (current[id] === onBack) return current;
        return { ...current, [id]: onBack };
      });
    },
    [],
  );

  const value = useMemo(() => ({ register }), [register]);
  // Last registration wins: a screen that opens a sub-screen leaves both
  // mounted for a frame, and the newer one is the one the reader is looking at.
  const keys = Object.keys(entries);
  const back = keys.length > 0 ? entries[keys[keys.length - 1]] : null;

  return <BackContext.Provider value={value}>{children(back)}</BackContext.Provider>;
}

/**
 * The bar itself.
 *
 * Two slots, in the two corners a thumb owns on a 6.7" phone, with the middle
 * left deliberately empty — a control in the centre of a bar is the one a
 * gloved hand hits by accident when reaching for either end.
 */
export function BottomBar({
  back,
  right,
}: {
  back: (() => void) | null;
  right?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-slate-800 bg-slate-950 px-3 py-2 safe-bottom">
      {back ? (
        <button
          type="button"
          onClick={back}
          aria-label="Back"
          className="tap flex h-11 items-center gap-2 rounded-xl px-3 text-slate-300 active:bg-slate-800"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </svg>
          <span className="text-sm font-semibold">Back</span>
        </button>
      ) : (
        /* Holds the corner open so the right-hand control does not slide
           across when a screen has nothing to go back to. */
        <span className="h-11" aria-hidden="true" />
      )}
      {right}
    </div>
  );
}
