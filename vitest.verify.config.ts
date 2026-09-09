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
  * - `npm run verify:simulate` — the pinned router executed against live Base state
  *   with `eth_call` state overrides. Proves the built swap settles before any
  *   allowance is granted. Needs `BASE_RPC_URL`: public endpoints reject overrides.
  * - `npm run verify:sell-quote` — the aggregator in the sell direction.
  * - `npm run verify:sell-simulate` — the pinned router executed for a sale
  *   against live state, from a real approver and with no overrides (B20
  *   precompile storage is not overridable; the script proves why).
  * - `npm run verify` — all six.
 *
 * Each script names its file so that verifying an address does not fire live
 * aggregator requests, and vice versa.
 *
 * `verify/env.ts` loads `.env` first. Vitest does not, and a live check that reads
 * through a public endpoint while the deployment reads through `BASE_RPC_URL` is
 * checking something nobody ships. `vitest.config.ts` has no such setup file, on
 * purpose: `npm test` must not acquire an opinion about a local environment.
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
    setupFiles: ["verify/env.ts"],
    testTimeout: 45_000,
  },
});
