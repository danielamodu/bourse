"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Clock3,
  LayoutDashboard,
  Settings,
  Sprout,
} from "lucide-react";

import { formatAddressShort } from "@/lib/format";

import { Mark } from "./Brand";

/**
 * The app frame, in the ported `app-shell` visual: sidebar on desktop,
 * header plus bottom nav on mobile.
 *
 * Two deliberate departures from the reference, both honesty rather than
 * style: the dark-mode toggle is gone (the app is light-only), and the wallet
 * chip states a fact — the connected address, or a link to connect. It never
 * shows a hardcoded address, and on pages without a wallet it links out
 * rather than pretending.
 */
export function AppShell({
  children,
  walletAddress,
}: {
  children: ReactNode;
  /** Connected address, or null where no wallet is known (light pages). */
  walletAddress: string | null;
}) {
  const pathname = usePathname();

  // Five entries; the mobile bar shows the first four, so History is
  // desktop-only there. Earn carries live data and wins the mobile slot over
  // a history shell that currently states it is unavailable.
  const navItems = [
    { href: "/markets", label: "Markets", icon: BarChart3 },
    { href: "/portfolio", label: "Portfolio", icon: LayoutDashboard },
    { href: "/earn", label: "Earn", icon: Sprout },
    { href: "/funding", label: "Funding", icon: ArrowUpRight },
    { href: "/history", label: "History", icon: Clock3 },
  ];

  const active = (href: string) => (pathname === href ? "active" : "");

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Link href="/" className="brand-lockup">
          <Mark size={31} />
          <span>bourse</span>
        </Link>
        <div className="side-label">YOUR ACCOUNT</div>
        <nav className="side-nav" aria-label="Account">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={active(href)}>
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="side-spacer" />
        <div className="side-nav">
          <Link href="/settings" className={active("/settings")}>
            <Settings size={17} />
            Settings
          </Link>
        </div>
        <div className="wallet-chip">
          <span className="wallet-avatar">0x</span>
          {walletAddress === null ? (
            <div>
              <strong>
                <Link href="/login">Connect wallet</Link>
              </strong>
              <span>Not connected</span>
            </div>
          ) : (
            <div>
              <strong>{formatAddressShort(walletAddress)}</strong>
              <span>Connected</span>
            </div>
          )}
        </div>
      </aside>

      <header className="mobile-app-header">
        <Link href="/" className="brand-lockup">
          <Mark size={29} />
          <span>bourse</span>
        </Link>
      </header>

      <main className="app-main">{children}</main>

      <nav className="mobile-bottom-nav" aria-label="Account">
        {navItems.slice(0, 4).map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={active(href)}>
            <Icon size={17} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
