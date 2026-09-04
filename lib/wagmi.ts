import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";

/**
 * Base mainnet only. There is no testnet config and no chain switcher: every
 * token, feed and pool this app touches lives on Base.
 */

/** `||` rather than `??` so an empty string in the environment still falls back. */
const rpcUrl = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";

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
