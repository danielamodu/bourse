import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Unit tests: offline and deterministic, no network, no RPC, no third-party APIs.
 *
 * Chain reads live in `vitest.verify.config.ts` behind `npm run verify:chain`.
 * The exclude below keeps any leftover `*.onchain.test.ts` out of this run — a
 * suite that goes red because a public endpoint rate-limited teaches us to
 * ignore red, which is worse than having no test.
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
    exclude: ["**/node_modules/**", "**/*.onchain.test.ts"],
  },
});
