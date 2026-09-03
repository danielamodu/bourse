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
  connectors: [
    /**
     * Smart wallet first, and deliberately `smartWalletOnly`.
     *
     * Our users are Nigerian retail with no crypto experience. Passkey
     * onboarding removes the seed-phrase cliff that loses most of them at step
     * one, and it is the path that lets us sponsor gas via a paymaster later —
     * which we will need, because nobody arrives holding ETH for fees.
     */
    coinbaseWallet({
      appName: "Bourse",
      preference: "smartWalletOnly",
    }),
    /** Fallback for the minority who already have a browser wallet. */
    injected({ shimDisconnect: true }),
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
