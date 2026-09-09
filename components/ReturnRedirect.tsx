"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";

import { Providers } from "@/app/providers";

/**
 * Returning wallets skip the marketing page.
 *
 * Mounted on landing through `next/dynamic` with `ssr: false`, so the
 * landing's first paint ships no wallet SDK — this whole tree (providers
 * included) loads lazily in the browser only. Once wagmi's silent reconnect
 * settles on `connected`, the visitor already has an account and belongs on
 * their dashboard, not on a pitch. Anything else — disconnected, still
 * reconnecting, or a wallet deliberately closed earlier — renders nothing
 * and the landing shows normally.
 */
export function ReturnRedirect() {
  return (
    <Providers>
      <Redirector />
    </Providers>
  );
}

function Redirector() {
  const { status } = useAccount();
  const router = useRouter();

  useEffect(() => {
    if (status === "connected") router.replace("/portfolio");
  }, [status, router]);

  return null;
}
