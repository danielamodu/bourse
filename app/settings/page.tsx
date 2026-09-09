"use client";

import Link from "next/link";
import { Copy } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { formatAddressShort } from "@/lib/format";
import { useWallet } from "@/hooks/useWallet";

/**
 * Settings on the ported visual, with only rows that do something real: the
 * wallet connects and disconnects, the currency is naira, and the legal
 * links go somewhere. Alerts and funding providers have no backend, so they
 * say so instead of toggling happily at nothing.
 */
export default function SettingsPage() {
  const wallet = useWallet({});

  return (
    <AppShell walletAddress={wallet.address}>
      <div className="page-header">
        <div>
          <div className="eyebrow">SETTINGS / PREFERENCES</div>
          <h1>Make Bourse yours.</h1>
          <p>Manage your account, wallet, and notifications.</p>
        </div>
      </div>

      <div className="settings-list">
        <div className="settings-section">
          <div>
            <div className="eyebrow">CONNECTED WALLET</div>
            <h3>Your wallet</h3>
          </div>
          {wallet.address === null ? (
            <div className="wallet-setting">
              <span className="wallet-avatar">0x</span>
              <div>
                <strong>No wallet connected</strong>
                <span>Connect to trade and see holdings</span>
              </div>
              <Link href="/login" className="button button-outline button-small">
                Connect
              </Link>
            </div>
          ) : (
            <div className="wallet-setting">
              <span className="wallet-avatar">0x</span>
              <div>
                <strong>{formatAddressShort(wallet.address)}</strong>
                <span>Connected on Base</span>
              </div>
              <button
                type="button"
                className="button button-outline button-small"
                onClick={wallet.disconnect}
              >
                Disconnect
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Copy wallet address"
                onClick={() => {
                  void navigator.clipboard.writeText(wallet.address ?? "");
                }}
              >
                <Copy size={15} />
              </button>
            </div>
          )}
        </div>

        <div className="settings-section">
          <div>
            <div className="eyebrow">DISPLAY</div>
            <h3>Preferences</h3>
          </div>
          <div>
            <div className="setting-row">
              <div>
                <strong>Default currency</strong>
                <span>Prices and balances shown in this currency</span>
              </div>
              <span>₦ Naira</span>
            </div>
            <div className="setting-row">
              <div>
                <strong>Price alerts</strong>
                <span>Get notified when a watchlisted stock moves</span>
              </div>
              <span>Not available yet</span>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div>
            <div className="eyebrow">LINKED ACCOUNTS</div>
            <h3>Funding providers</h3>
          </div>
          <div className="setting-row">
            <div>
              <strong>No funding providers yet</strong>
              <span>Funding in naira is coming soon</span>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div>
            <div className="eyebrow">LEGAL &amp; SUPPORT</div>
            <h3>Need a hand?</h3>
          </div>
          <div className="settings-links">
            <Link href="/terms">Terms of service</Link>
            <Link href="/privacy">Privacy policy</Link>
            <Link href="/docs">How Bourse works</Link>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
