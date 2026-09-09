"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";

import { formatConnectorName } from "@/lib/format";
import { useWallet, type WalletOption } from "@/hooks/useWallet";

import { Mark } from "./Brand";
import { WalletIcon } from "./WalletIcon";

/**
 * Sign in on the ported `auth-page` visual: wallet chooser on the left,
 * editorial panel on the right.
 *
 * The wallets are real connectors in offer order, and connecting lands on
 * markets — the reference showed hardcoded wallets and a toast, both gone.
 */
export function AuthPage() {
  const { address, connectors, connect } = useWallet({});
  const router = useRouter();

  useEffect(() => {
    if (address !== null) router.push("/markets");
  }, [address, router]);

  return (
    <div className="auth-page">
      <div className="auth-form-side">
        <Link href="/" className="brand-lockup">
          <Mark size={32} />
          <span>bourse</span>
        </Link>
        <div className="auth-form-wrap">
          <div className="eyebrow">ACCESS BOURSE</div>
          <p>
            Connect a wallet to fund, trade, and keep your global ownership in
            view.
          </p>
          <div className="wallet-list">
            {connectors.map((connector: WalletOption) => {
              const label = formatConnectorName(connector.name);
              return (
                <button
                  key={connector.uid}
                  type="button"
                  className="wallet-option auth-wallet-option"
                  onClick={() => connect(connector.uid)}
                  aria-label={`Connect ${label}`}
                >
                  <span className="wallet-avatar" aria-hidden="true">
                    <WalletIcon icon={connector.icon} />
                  </span>
                  <span>
                    <strong>{label}</strong>
                    <small>Connect to continue</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              );
            })}
          </div>
          <div className="auth-switch">
            New to wallets? <a href="/#how-it-works">Learn how they work</a>
          </div>
          <div className="auth-disclaimer">
            <ShieldCheck size={15} /> Bourse never sees or stores your wallet
            keys.
          </div>
        </div>
        <div className="auth-foot">
          <span>© 2026 Bourse</span>
          <span>Built on Base · Designed for clarity</span>
        </div>
      </div>
      <div
        className="auth-visual"
        style={{ backgroundImage: "url(/hero.webp)" }}
      >
        <div className="auth-visual-wash" />
        <div className="auth-quote">
          <div className="eyebrow">BOURSE / 01</div>
          <h2>Your portfolio should feel like yours.</h2>
          <div className="auth-quote-foot">
            <span>₦ ↔ GLOBAL OWNERSHIP</span>
            <span>→</span>
          </div>
        </div>
      </div>
    </div>
  );
}
