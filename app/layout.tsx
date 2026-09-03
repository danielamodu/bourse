import type { Metadata } from "next";
import { DM_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
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
};

/**
 * Fonts, tokens and metadata only.
 *
 * The wallet stack deliberately is not here — it is mounted by
 * `app/trade/layout.tsx`, so a browsing page never downloads it.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${dmMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
