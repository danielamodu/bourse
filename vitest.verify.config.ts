import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Chain checks. Separate from `vitest.config.ts` on purpose.
 *
 * `npm test` must run offline and deterministically, because it is the only
 * feedback loop available here. This config is the other half: real reads
 * against Base, run deliberately via `npm run verify:chain` after an address or
 * ABI change.
 *
 * The timeout is generous because each read may fall through three endpoints,
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
