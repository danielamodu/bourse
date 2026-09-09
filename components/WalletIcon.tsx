"use client";

import { useState } from "react";
import { Wallet as WalletGlyph } from "lucide-react";

/**
 * A wallet's own mark — or a neutral glyph where it supplies none.
 *
 * The image comes from the connector itself (`useWallet` reads wagmi's
 * EIP-6963 `icon`), so a wallet nobody has heard of still shows its own
 * face rather than our guess at it. Anything that fails to load — a dead
 * URL on poor mobile data, a malformed data URI — falls back to the same
 * glyph, which is also what generic and SDK connectors render. No initials,
 * ever: two wallets can share a letter, and a letter is not a mark.
 *
 * Rendered inside the existing `.wallet-avatar` circle, which stays dark —
 * full-color brand marks sit on it the way every wallet chooser shows them.
 */
export function WalletIcon({ icon }: { icon: string | null }) {
  const [failed, setFailed] = useState(false);

  if (icon !== null && !failed) {
    return (
      <img
        className="wallet-icon"
        src={icon}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
      />
    );
  }

  return <WalletGlyph size={15} aria-hidden="true" />;
}
