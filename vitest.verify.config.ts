import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Live checks. Separate from `vitest.config.ts` on purpose.
 *
 * `npm test` must run offline and deterministically, because it is the only
 * feedback loop available here. This config is the other half: real requests, run
 * deliberately.
 *
 * - `npm run verify:chain` — reads against Base, after an address or ABI change.
 * - `npm run verify:quote` — the KyberSwap aggregator, after a change to the
 *   request, the response mapping, or `NO_ROUTE_MESSAGE`.
 * - `npm run verify:build` — the aggregator's build endpoint, after a change to the
 *   build request, its guards, or the router pin. Builds calldata and signs nothing.
 * - `npm run verify` — all three.
 *
 * Each script names its file so that verifying an address does not fire live
 * aggregator requests, and vice versa.
 *
 * The timeout is generous because a chain read may fall through three endpoints,
 * each with its own 12s request timeout and a delay in front of it.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  test: {
    environment: "node",
    include: ["verify/**/*.verify.ts"],
    testTimeout: 45_000,
  },
});
