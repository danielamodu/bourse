import { describe, expect, it } from "vitest";

import { quoteBandNgn, withNgnQuote } from "@/lib/quote-ngn";
import {
  MAX_QUOTE_USDC_UNITS,
  MIN_QUOTE_USDC_UNITS,
  ngnToUsdcUnits,
  type Quote,
} from "@/lib/quote";

/**
 * The naira join, tested with a hand-built quote — no network and no aggregator,
 * because none of this arithmetic depends on either.
 */

const NOW = 1_757_000_000_000;

/** $30 buys 0.05 of a $600 share. Gas $0.004. */
function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "NVDA",
    usdcIn: 30_000_000n,
    usdIn: 30,
    unitsOut: 5_000_000n,
    shares: 0.05,
    usdPerShare: 600,
    priceImpactBps: 20,
    gasUsd: 0.004,
    routerAddress: null,
    receivedAtMs: NOW,
    expiresAtMs: NOW + 30_000,
    ...overrides,
  };
}

/** A plausible parallel-market rate. Nothing here depends on the exact figure. */
const RATE = 1_650;

describe("withNgnQuote", () => {
  it("converts every USD figure the panel shows", () => {
    const ngnQuote = withNgnQuote(quote(), RATE);

    expect(ngnQuote.ngnIn).toBe(49_500);
    expect(ngnQuote.ngnPerShare).toBe(990_000);
    expect(ngnQuote.gasNgn).toBeCloseTo(6.6, 9);
  });

  it("keeps the quote itself untouched", () => {
    const original = quote();
    const ngnQuote = withNgnQuote(original, RATE);

    // The shares figure and the impact are true without a rate, so the quote is
    // carried through rather than rebuilt.
    expect(ngnQuote.quote).toBe(original);
  });

  it("blanks the naira rows without a rate rather than the whole quote", () => {
    const ngnQuote = withNgnQuote(quote(), null, 620);

    expect(ngnQuote.ngnIn).toBeNull();
    expect(ngnQuote.ngnPerShare).toBeNull();
    expect(ngnQuote.gasNgn).toBeNull();
    // The premium is a USD-to-USD comparison, so a missing rate does not touch it.
    expect(ngnQuote.premiumBps).toBe(-322);
    expect(ngnQuote.quote.shares).toBe(0.05);
  });

  it("blanks the naira rows on a rate that cannot be used", () => {
    for (const rate of [0, -1_650, Number.NaN]) {
      expect(withNgnQuote(quote(), rate).ngnIn, String(rate)).toBeNull();
    }
  });

  it("measures the premium against the reference, signed", () => {
    // $600 executed against a $620 reference is a discount: -322.58bps exactly,
    // shown as -322. Both directions round toward positive infinity, so a premium
    // is never understated and a discount never flattered — see `ceilBps`.
    expect(withNgnQuote(quote(), RATE, 620).premiumBps).toBe(-322);
    // …and against $580 a premium: 344.83bps, shown as 345.
    expect(withNgnQuote(quote(), RATE, 580).premiumBps).toBe(345);
    expect(withNgnQuote(quote(), RATE, 600).premiumBps).toBe(0);
  });

  it("leaves the premium blank without a reference price", () => {
    // Nine of the thirteen have no usable reading at any given moment, and a
    // premium against nothing is not zero.
    expect(withNgnQuote(quote(), RATE).premiumBps).toBeNull();
    expect(withNgnQuote(quote(), RATE, null).premiumBps).toBeNull();
    expect(withNgnQuote(quote(), RATE, 0).premiumBps).toBeNull();
  });

  it("reports gas as null when the route carried no estimate", () => {
    expect(withNgnQuote(quote({ gasUsd: null }), RATE).gasNgn).toBeNull();
  });
});

describe("quoteBandNgn", () => {
  it("states the $1 floor and $1,000,000 ceiling in naira", () => {
    expect(quoteBandNgn(RATE)).toEqual({
      minNgn: 1_650,
      maxNgn: 1_650_000_000,
    });
  });

  it("is blank before a rate has been fetched", () => {
    expect(quoteBandNgn(null)).toEqual({ minNgn: null, maxNgn: null });
    expect(quoteBandNgn(0)).toEqual({ minNgn: null, maxNgn: null });
  });

  it("rounds inward on both ends", () => {
    const { minNgn, maxNgn } = quoteBandNgn(1_650.5);

    expect(minNgn).toBe(1_651);
    expect(maxNgn).toBe(1_650_500_000);
  });

  /**
   * The reason the rounding goes inward.
   *
   * `ngnToUsdcUnits` floors, so a floor stated as ₦1,650.5 would be typed as
   * ₦1,650 and come back a unit short of the minimum the route accepts — the
   * panel would name an amount and then reject it.
   */
  it("names amounts the route will actually accept", () => {
    for (const rate of [1_650, 1_650.5, 1_234.56789, 987.654321, 1_500]) {
      const { minNgn, maxNgn } = quoteBandNgn(rate);
      expect(minNgn, `min at ${rate}`).not.toBeNull();
      expect(maxNgn, `max at ${rate}`).not.toBeNull();
      if (minNgn === null || maxNgn === null) continue;

      const atMin = ngnToUsdcUnits(minNgn, rate);
      const atMax = ngnToUsdcUnits(maxNgn, rate);
      expect(atMin, `min at ${rate}`).not.toBeNull();
      expect(atMax, `max at ${rate}`).not.toBeNull();
      if (atMin === null || atMax === null) continue;

      expect(atMin >= MIN_QUOTE_USDC_UNITS, `min at ${rate}`).toBe(true);
      expect(atMax <= MAX_QUOTE_USDC_UNITS, `max at ${rate}`).toBe(true);
    }
  });
});
