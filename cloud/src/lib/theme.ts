// Light/dark, remembered per device.
//
// No stored choice follows the OS (globals.css's `prefers-color-scheme`
// block); the toggle in Settings writes an explicit choice here, which then
// wins regardless of what the OS says. `applyBootTheme` runs inline, before
// hydration — see the script in layout.tsx — so the very first paint is
// already right rather than flashing dark and then repainting light.

export type Theme = "light" | "dark";

export const THEME_KEY = "electronix.theme";

/** The exact source the inline boot script runs. Kept as one string so the
 *  script tag and this module can never drift apart. */
export const BOOT_THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** What is actually on screen right now, stored choice or not. */
export function getEffectiveTheme(): Theme {
  const stored = getStoredTheme();
  if (stored) return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* A device with storage disabled just keeps the in-memory attribute for
       this load — still correct, just not remembered next time. */
  }
}
