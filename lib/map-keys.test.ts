import { describe, expect, it } from "vitest";

import { mapKeys } from "@/lib/map-keys";
import { STOCK_SYMBOLS, STOCK_TOKENS } from "@/lib/tokens";

/**
 * `mapKeys` exists to hold one type assertion, and the assertion is only honest
 * if the returned record really has every key. That is what these check — the
 * types cannot, since the cast is the thing under test.
 */

describe("mapKeys", () => {
  it("returns one entry per key, in the order given", () => {
    const result = mapKeys(["a", "b", "c"] as const, (key) =>
      key.toUpperCase(),
    );

    expect(Object.keys(result)).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ a: "A", b: "B", c: "C" });
  });

  it("calls make exactly once per key, with that key", () => {
    const seen: string[] = [];
    mapKeys(["one", "two"] as const, (key) => {
      seen.push(key);
      return key.length;
    });

    expect(seen).toEqual(["one", "two"]);
  });

  it("returns an empty record for an empty key list", () => {
    expect(Object.keys(mapKeys([], () => 1))).toEqual([]);
  });

  it("holds values that are objects without sharing one instance", () => {
    const result = mapKeys(["a", "b"] as const, () => ({ count: 0 }));
    result.a.count = 1;

    expect(result.b.count).toBe(0);
  });

  /**
   * The reason the helper is in the tree: a registry built through it covers
   * every symbol, so nothing reads `undefined` off `STOCK_TOKENS` at runtime.
   */
  it("gives STOCK_TOKENS an entry for all 13 symbols", () => {
    expect(Object.keys(STOCK_TOKENS)).toHaveLength(STOCK_SYMBOLS.length);

    for (const symbol of STOCK_SYMBOLS) {
      const token = STOCK_TOKENS[symbol];
      expect(token, `${symbol} missing from STOCK_TOKENS`).toBeDefined();
      expect(token.symbol).toBe(symbol);
      expect(token.feedAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});
