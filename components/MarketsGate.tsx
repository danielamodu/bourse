"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";

import { Providers } from "@/app/providers";

/**
 * The markets gate: this route is the dashboard, and it is not public.
 *
 * Mounted on `/markets` through `next/dynamic` with `ssr: false`, so the
 * page's first paint still ships no wallet SDK — this whole tree loads
 * lazily in the browser only. After a grace period, a
 * settled-disconnected visitor is replaced into `/login`. The grace plus
 * the settled-state check exist so a wallet still silently reconnecting is
 * never bounced mid-handshake: only a decided `disconnected` redirects,
 * never `connecting` or `reconnecting`, however long they take. No wallet
 * installed reads as `disconnected` too, and `/login` offers Coinbase
 * Wallet to exactly that visitor.
 */
export function MarketsGate() {
  return (
    <Providers>
      <Gate />
    </Providers>
  );
}

function Gate() {
  const { status } = useAccount();
  const router = useRouter();
  const [graceExpired, setGraceExpired] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setGraceExpired(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  const shut = graceExpired && status === "disconnected";

  useEffect(() => {
    if (shut) router.replace("/login");
  }, [shut, router]);

  return null;
}
