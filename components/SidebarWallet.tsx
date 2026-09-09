"use client";

import Link from "next/link";
import { useAccount } from "wagmi";

import { Providers } from "@/app/providers";
import { formatAddressShort } from "@/lib/format";

/**
 * The sidebar chip for pages without a wallet of their own.
 *
 * Markets, earn, funding and history read no account, so they cannot pass a
 * live address — but a hardcoded "not connected" chip lies to connected
 * visitors. This island fixes that without bloating first paint: it mounts
 * through `next/dynamic` with `ssr: false` (see `AppShell`), so the wallet
 * SDK loads lazily in the browser only, and it reads connection state alone
 * — no balances, no RPC reads, nothing that could disagree with another
 * hook's numbers. While it loads or reconnects, the connect link shows;
 * flipping to the address the moment wagmi settles is the honest transient.
 */
export function SidebarWallet() {
  return (
    <Providers>
      <Chip />
    </Providers>
  );
}

function Chip() {
  const { address, status } = useAccount();

  if (status === "connected" && address !== undefined) {
    return (
      <div>
        <strong>{formatAddressShort(address)}</strong>
        <span>Connected</span>
      </div>
    );
  }

  return (
    <div>
      <strong>
        <Link href="/login">Connect wallet</Link>
      </strong>
      <span>Not connected</span>
    </div>
  );
}
