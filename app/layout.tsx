import type { Metadata } from "next";
import { DM_Mono, DM_Sans, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

import "./design.css";

/**
 * The ported visual system's families, self-hosted. Same weights the design
 * loads (DM Sans 400–700, Space Grotesk 400–600, DM Mono 400–500); design.css
 * reads them through these variables with the family names as fallback.
 */
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-space-grotesk",
  display: "swap",
});

/** Reserved for addresses, hashes, exact rates and technical identifiers. */
const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Bourse",
  description: "Buy Coinbase tokenized US stocks with Nigerian naira, on Base.",
  icons: {
    // Recovered from the reference repo's own history alongside the logo
    // mark (same image, committed as bourse-favicon.png).
    icon: "/favicon.png",
  },
};

/**
 * Fonts, tokens and metadata only.
 *
 * The wallet stack deliberately is not here — it is mounted per route that
 * needs a wallet (`app/trade/layout.tsx`, `app/portfolio/layout.tsx`,
 * `app/settings/layout.tsx`, `app/(auth)/layout.tsx`), so a browsing page
 * never downloads it.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${dmMono.variable} ${dmSans.variable} ${spaceGrotesk.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
