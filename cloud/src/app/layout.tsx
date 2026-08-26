import type { Metadata, Viewport } from "next";
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
  themeColor: "#020617",
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
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
