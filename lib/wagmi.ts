import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";

/**
 * Base mainnet only. There is no testnet config and no chain switcher: every
 * token, feed and pool this app touches lives on Base.
 */

/**
 * The browser's endpoint, and it is the public one on purpose.
 *
 * DO NOT POINT THIS AT `BASE_RPC_URL`, AND DO NOT ADD A `NEXT_PUBLIC_` COPY OF IT
 * TO REACH IT FROM HERE. The two sides read differently:
 *
 * - Server reads concentrate. Every visitor to `/markets` is served by the same
 *   Vercel instance from the same address, so thirteen feed reads times everyone
 *   arrive at one endpoint as one caller. That is the rate limit `BASE_RPC_URL`
 *   exists to get out from under — see `dedicatedRpcUrl` in `lib/rpc.ts`.
 * - These reads do not. A balance and an allowance per person, issued from that
 *   person's own browser and their own IP, spread across as many callers as there
 *   are users.
 *
 * So a key in front of this buys nothing worth having, and the only way to ship one
 * to a browser is `NEXT_PUBLIC_`, which inlines it into JavaScript anyone can read.
 * It would be scraped and burned through by strangers, and we would be paying for
 * their traffic to make a handful of per-user reads marginally faster.
 */
const rpcUrl = "https://mainnet.base.org";

export const config = createConfig({
  chains: [base],
  /**
   * Order is the offer. The wallet someone already has comes first.
   *
   * Everyone who can buy shares here is already holding USDC in a wallet they
   * control — that is the precondition, not an upgrade path. So the first thing
   * this screen can offer is "connect the one you have", and Coinbase Wallet is
   * the second thing, for whoever has no browser wallet at all.
   *
   * DO NOT REORDER THIS AND DO NOT GO BACK TO `smartWalletOnly`. Both decisions
   * are pinned by `lib/wagmi.test.ts`, which exists because this is the kind of
   * change that looks like a tidy-up.
   */
  connectors: [
    injected({ shimDisconnect: true }),
    /**
     * `preference: "all"`, not `"smartWalletOnly"`.
     *
     * `"smartWalletOnly"` refuses to connect an existing Coinbase Wallet — the
     * extension or the mobile app — and offers a fresh passkey Smart Wallet as
     * the only option. A fresh Smart Wallet is an empty account: no USDC, no
     * ETH, and no way to reach either without going back to the wallet the user
     * was not allowed to connect. Smooth onboarding into a dead end.
     *
     * It is also an embedded wallet in all but name, and Bourse has no
     * paymaster to make one worth having: with gas unsponsored, a Smart Wallet
     * pays its own fees exactly like an EOA, so the ETH check in
     * `lib/wallet-state.ts` applies to both and the passkey buys nothing here.
     *
     * `"all"` keeps the Smart Wallet on offer for people with no wallet at all
     * while letting everyone else connect what they are already using.
     */
    coinbaseWallet({
      appName: "Bourse",
      preference: "all",
    }),
  ],
  transports: {
    [base.id]: http(rpcUrl),
  },
  /** Required under the App Router: the config is created during SSR too. */
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
