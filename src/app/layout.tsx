import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Legal Intake Engine",
  description: "Internal scaffold — see the c19/c21 board cards for status.",
};

// Theme fonts (Instrument Serif for display, Manrope for UI) are linked
// from Google Fonts at request time rather than via next/font, so
// `next build` never needs network access (CI builds offline-safe).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
