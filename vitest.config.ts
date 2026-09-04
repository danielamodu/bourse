import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Unit tests: offline and deterministic, no network, no RPC, no third-party APIs.
 *
 * Live checks — chain reads and the KyberSwap aggregator — live in
 * `vitest.verify.config.ts`, behind `npm run verify:chain` and
 * `npm run verify:quote`.
 *
 * WHY THE INCLUDE IS REPO-WIDE. It used to name `{app,hooks,lib}`, which meant a
 * test file written anywhere else — `components/`, `verify/`, the repo root — ran
 * never and reported nothing. A test that silently does not run is worse than a
 * missing test, because the suite goes green and someone reads that as coverage.
 * So the rule is now the plain one: a file ending `.test.ts` or `.test.tsx`
 * anywhere in the repo is part of this run.
 *
 * The separation from the live checks survives that on two counts. Those files are
 * named `*.verify.ts`, which does not match the include at all, and `verify/` is
 * excluded by path as well — belt and braces, so that adding `verify/foo.test.ts`
 * cannot quietly put a network read into `npm test`. `.next/` is excluded because a
 * build copies source into it and a compiled duplicate of a test is not a test.
 *
 * `environment: "node"` and no jsdom, so a component test would need a deliberate
 * environment change rather than appearing to work: today every test here is pure
 * logic.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "verify/**", ".next/**", "coverage/**"],
  },
});
