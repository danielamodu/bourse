"use client";

import { ChevronRight, CircleHelp, X } from "lucide-react";

import { formatConnectorName } from "@/lib/format";
import type { WalletOption } from "@/hooks/useWallet";

/**
 * The wallet chooser, in the ported `connect-modal` markup.
 *
 * The options are real connectors in offer order (`hooks/useWallet`), not the
 * hardcoded MetaMask/Phantom pair the reference showed. Connecting signs and
 * spends nothing — it only lets the app read balances.
 */
export function ConnectModal({
  open,
  onClose,
  connectors,
  onConnect,
}: {
  open: boolean;
  onClose: () => void;
  connectors: readonly WalletOption[];
  onConnect: (uid: string) => void;
}) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="connect-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Connect your wallet"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={17} />
        </button>
        <div className="eyebrow">WELCOME TO BOURSE</div>
        <h2>
          Connect your wallet
          <br />
          <em>to begin.</em>
        </h2>
        <p>
          Your wallet is your account on Bourse. It lets you fund, trade, and
          keep ownership of your assets.
        </p>
        {connectors.map((connector) => {
          const label = formatConnectorName(connector.name);
          return (
            <button
              key={connector.uid}
              type="button"
              className="wallet-option"
              onClick={() => onConnect(connector.uid)}
            >
              <span className="wallet-avatar" aria-hidden="true">
                {label.slice(0, 1)}
              </span>
              <span>
                <strong>{label}</strong>
                <small>Connect to continue</small>
              </span>
              <ChevronRight size={17} />
            </button>
          );
        })}
        <div className="modal-foot">
          <CircleHelp size={15} /> New to wallets?{" "}
          <a href="/#how-it-works">Learn how they work</a>
        </div>
      </div>
    </div>
  );
}
