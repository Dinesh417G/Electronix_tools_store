// Getting the screen back after the phone took it away.
//
// A tablet in a workshop is backgrounded constantly — the print dialogue opens,
// the screen locks, somebody takes a call, the browser throttles a hidden tab
// and kills its fetches. Every one of those surfaced as "The store server is
// not reachable." over a screen that then sat there, because nothing ever
// asked again.
//
// Two triggers, and both matter:
//
//   visibilitychange  the tab came back to the foreground. This is the common
//                     one and the one the first user hit, twice.
//   online            the radio came back. Fires without a visibility change
//                     when the tablet never left the foreground at all.
//
// Deliberately not a poll. §4 already polls the one screen where freshness is
// the point (the claim screen); a console that re-fetches the catalog every few
// seconds would spend a shop-floor tablet's battery to keep a list of tool
// codes that changes weekly up to date.

import { useEffect } from "react";

export function useRefreshOnReturn(reload: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reload);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reload);
      window.removeEventListener("focus", onVisible);
    };
  }, [reload, enabled]);
}
