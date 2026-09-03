import type { NextConfig } from "next";

/**
 * `outputFileTracingRoot` pins tracing to this directory so the standalone
 * output does not walk up out of the repo looking for a workspace root.
 *
 * The `@x402/*` aliases are load-bearing — see the "Dependency stub in
 * next.config" section of CLAUDE.md before touching them. `wagmi/connectors` is
 * a barrel that pulls in the `baseAccount` connector, which reaches
 * `@base-org/account` → `@coinbase/cdp-sdk` → `@x402/*`. Those are optional
 * deps we deliberately do not install, so `next build` fails with
 * "Module not found" on five `@x402/*` specifiers. Bourse uses only
 * `coinbaseWallet`, so that whole branch is dead code and aliasing it to
 * `false` cuts it out.
 *
 * Do not install `@x402/*`, `@base-org/account`, or `@coinbase/cdp-sdk` to
 * satisfy the resolver, and do not add `--turbopack` to the dev script:
 * Turbopack's `resolveAlias` cannot map a module to `false`, so it cannot
 * express this stub.
 *
 * `@react-native-async-storage/async-storage` and `pino-pretty` are the same
 * shape of problem, reached through WalletConnect in that barrel: an optional
 * React Native storage adapter and an optional pretty log formatter. Neither is
 * installed and neither runs in a browser.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core": false,
      "@x402/evm": false,
      "@x402/svm": false,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };

    return config;
  },
};

export default nextConfig;
