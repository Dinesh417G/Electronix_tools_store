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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
