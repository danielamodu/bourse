import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Unit tests: offline and deterministic, no network, no RPC, no third-party APIs.
 *
 * Live checks — chain reads and the KyberSwap aggregator — live in
 * `vitest.verify.config.ts`, behind `npm run verify:chain` and
 * `npm run verify:quote`. Nothing under `verify/` matches the include below, so
 * the separation is structural rather than a list of exceptions — a new offline
 * test is picked up automatically, and a new network read has to be put somewhere
 * this run cannot see.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  test: {
    environment: "node",
    include: ["{app,hooks,lib}/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**"],
  },
});
