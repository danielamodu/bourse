"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { config } from "@/lib/wagmi";

/**
 * Wallet and query plumbing for the routes that need a wallet.
 *
 * Mounted by `app/trade/layout.tsx`, not by the root layout: `/markets` browses
 * without a connection and reads its prices on the server, so it must not pay for
 * a wallet SDK it never calls. Nothing here gates rendering on a connection
 * either — every page is browseable without a wallet, and the gate belongs at the
 * moment of action, not before.
 */
export function Providers({ children }: { children: ReactNode }) {
  // Created lazily and held in state so a client is never shared across
  // requests on the server, and never rebuilt on re-render in the browser.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
