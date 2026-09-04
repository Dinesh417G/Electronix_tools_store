// The bottom bar, and the one thing every screen needs to put in it.
//
// Why a bar rather than the floating button it replaces: a `fixed` control sits
// *over* content, and padding only protects the end of a list. Everything in
// the middle of a long one still scrolls underneath — which is how the settings
// gear came to be sitting on top of a row's quantity in Reports → By item, and
// on "Serials" in the cloud console before that. Reserved space cannot have the
// problem: the bar is a flex sibling of the screen, not an overlay, so the
// scrolling region ends where the bar begins.
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
  useRef,
  useState,
  type ReactNode,
} from "react";

interface BackRegistration {
  register: (id: string, onBack: (() => void) | null) => void;
}

const BackContext = createContext<BackRegistration>({ register: () => {} });

/**
 * Called by `Header`. A screen with no back action passes nothing.
 *
 * The registration effect keys on *whether* a handler exists, not on the
 * handler's identity — `register`'s own bail-out check (`current[id] ===
 * onBack`) is a reference comparison, and most callers pass an inline
 * `() => setStep(...)`, a fresh closure every render. Depending on `onBack`
 * directly re-registers on every one of those renders, which changes the
 * entries, which re-renders the provider, which re-renders whatever built the
 * inline closure, which renders a new one — an update loop with no fixed point.
 * The ref keeps the latest closure callable without making the effect sensitive
 * to it changing.
 */
export function useRegisterBack(onBack?: () => void): void {
  const { register } = useContext(BackContext);
  const id = useId();
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  const hasBack = onBack !== undefined;

  useEffect(() => {
    if (!hasBack) {
      register(id, null);
      return;
    }
    register(id, () => onBackRef.current?.());
    return () => register(id, null);
  }, [register, id, hasBack]);
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
  const newest = Object.keys(entries).at(-1);
  const back = newest === undefined ? null : (entries[newest] ?? null);

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
          <span className="text-xl leading-none">←</span>
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
