/**
 * Builds a record with one entry per key.
 *
 * `Object.fromEntries` cannot know the entry list covered every key, so it
 * returns a string index signature and the result is not assignable to
 * `Record<K, V>`. The assertion that closes that gap lives here, once, behind a
 * signature that makes it true rather than merely asserted: the only keys that
 * can reach `out` come from `keys`, and `make` runs for each of them, so every
 * property of `Record<K, V>` exists by the time it is returned.
 *
 * Keeping the cast here is what preserves exhaustiveness at the call sites. An
 * `as unknown as Record<StockSymbol, StockToken>` at the `STOCK_TOKENS`
 * definition would type a half-built registry as complete; going through this,
 * the keys are `STOCK_SYMBOLS` by construction, so a missing symbol is a
 * compile error rather than an `undefined` price at runtime.
 */
export function mapKeys<K extends string, V>(
  keys: readonly K[],
  make: (key: K) => V,
): Record<K, V> {
  const out = {} as Record<K, V>;

  for (const key of keys) {
    out[key] = make(key);
  }

  return out;
}
