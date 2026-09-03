import type { Metadata, Viewport } from "next";
import { BOOT_THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "ElectronIx Tool Store",
  description: "Tool-crib management for a CNC tooling store.",
};

export const viewport: Viewport = {
  // §12: this runs on a phone in a pocket and a tablet on a wall. Pinch-zoom is
  // left enabled — an operator squinting at a bin location should be able to
  // zoom — but the initial scale is pinned so the terminal opens at the size it
  // was designed for.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
};

// Typed explicitly rather than with Next's generated `LayoutProps<"/">`.
// That type is written into .next/types during a build, so using it makes
// `tsc --noEmit` depend on a build having already happened — which passes
// locally off a stale .next and fails in CI, where typecheck runs first.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        {/* Sets `data-theme` before the first paint, off last device's choice.
            Blocking and inline on purpose: a script tag loaded the normal way
            would run after the browser has already painted the (wrong, dark)
            default once — the one frame this exists to prevent. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
