import { describe, expect, it } from "vitest";

import {
  ceilBps,
  combineStockPrice,
  computePremiumBps,
  FEED_STALE_AFTER_MS,
  scaleBigInt,
  toNgn,
  type FeedReading,
} from "./price";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const NGN_RATE = 1_500;

/** $201.23 at the 8 decimals the Coinbase equity feeds use. */
const fresh = (overrides: Partial<FeedReading> = {}): FeedReading => ({
  answer: 20_123_000_000n,
  updatedAt: BigInt(Math.floor((NOW - 60_000) / 1000)),
  decimals: 8,
  ...overrides,
});

describe("scaleBigInt", () => {
  it("scales by the feed's own decimals", () => {
    expect(scaleBigInt(20_123_000_000n, 8)).toBeCloseTo(201.23, 8);
    expect(scaleBigInt(20_123n, 2)).toBeCloseTo(201.23, 8);
    expect(scaleBigInt(201n, 0)).toBe(201);
  });

  it("keeps the integer part of a large 18-decimal value", () => {
    expect(scaleBigInt(1_234_567_890n * 10n ** 18n, 18)).toBe(1_234_567_890);
  });

  it("handles negatives and rejects unscalable decimals", () => {
    expect(scaleBigInt(-20_123_000_000n, 8)).toBeCloseTo(-201.23, 8);
    expect(scaleBigInt(1n, -1)).toBeNaN();
    expect(scaleBigInt(1n, 255)).toBeNaN();
  });
});

describe("toNgn", () => {
  it("converts at the given rate", () => {
    expect(toNgn(2, 1_500)).toBe(3_000);
  });

  it("refuses an unusable rate or price", () => {
    expect(toNgn(2, 0)).toBeNull();
    expect(toNgn(2, -1_500)).toBeNull();
    expect(toNgn(2, Number.NaN)).toBeNull();
    expect(toNgn(null, 1_500)).toBeNull();
  });
});

describe("ceilBps", () => {
  it("rounds a fraction of a basis point up to one", () => {
    // The whole point of the contract: a cost smaller than the smallest figure we
    // can display is still a cost, and rounding it to 0 would claim a free route.
    expect(ceilBps(0.5)).toBe(1);
    expect(ceilBps(0.1)).toBe(1);
    // A millionth of a basis point, to show the epsilon is nowhere near large
    // enough to swallow one.
    expect(ceilBps(0.000_001)).toBe(1);
  });

  it("leaves a figure that is already whole alone", () => {
    expect(ceilBps(20)).toBe(20);
    expect(ceilBps(1_000)).toBe(1_000);
    expect(ceilBps(-100)).toBe(-100);
  });

  it("lifts a figure that floating point left just short of whole", () => {
    // `(30 - 29.94) / 30 * 10_000` is 19.999999999999574, not 20. Ceiling is what
    // recovers the figure a person would write down.
    expect(ceilBps(19.999999999999574)).toBe(20);
    expect(ceilBps(999.9999999999999)).toBe(1_000);
  });

  it("does not charge a basis point for a figure left just over whole", () => {
    // The other side of the same noise, and the reason for `BPS_EPSILON`:
    // `(30 - 29.97) / 30 * 10_000` is 10.000000000000379, and a route costing
    // exactly 10bps must not be presented as costing 11.
    expect(ceilBps(10.000000000000379)).toBe(10);
    expect(ceilBps(20.00000000000076)).toBe(20);
    // And the same on the other side of zero: a 100bp discount stays 100, rather
    // than losing a basis point to the same noise.
    expect(ceilBps(-99.99999999999999)).toBe(-100);
  });

  it("rounds a discount toward zero, so a saving is never flattered", () => {
    // -322.58bps reads as -322. Toward positive infinity in the signed sense,
    // which for a discount means the smaller saving of the two.
    expect(ceilBps(-322.58064516129031)).toBe(-322);
    expect(ceilBps(344.82758620689656)).toBe(345);
    expect(ceilBps(3_333.3333333333335)).toBe(3_334);
  });

  it("answers a positive zero, never -0", () => {
    // `Math.ceil` gives -0 for anything in (-1, 0], and `Object.is(-0, 0)` is
    // false — so a parity reading would fail a `toBe(0)` without the collapse,
    // and could render as "-0.00%".
    expect(Object.is(ceilBps(0), 0)).toBe(true);
    expect(Object.is(ceilBps(-1e-12), 0)).toBe(true);
    expect(Object.is(ceilBps(-0.5), 0)).toBe(true);
  });
});

describe("computePremiumBps", () => {
  it("reports a premium and a discount", () => {
    expect(computePremiumBps(202, 200)).toBe(100);
    expect(computePremiumBps(198, 200)).toBe(-100);
    expect(computePremiumBps(200, 200)).toBe(0);
  });

  it("rounds both directions the same way", () => {
    // $600 traded against a $620 reference and against $580. Both figures are read
    // by someone deciding whether to pay this price, so both round up.
    expect(computePremiumBps(600, 620)).toBe(-322);
    expect(computePremiumBps(600, 580)).toBe(345);
  });

  it("is null without both sides", () => {
    expect(computePremiumBps(null, 200)).toBeNull();
    expect(computePremiumBps(202, null)).toBeNull();
    expect(computePremiumBps(202, 0)).toBeNull();
  });
});

describe("combineStockPrice staleness", () => {
  it("treats a recent reading as current", () => {
    const price = combineStockPrice({ reading: fresh(), ngnRate: NGN_RATE, nowMs: NOW });

    expect(price.usd).toBeCloseTo(201.23, 8);
    expect(price.ngn).toBeCloseTo(301_845, 6);
    expect(price.stale).toBe(false);
    expect(price.unusable).toBeNull();
    expect(price.updatedAt).toBe(NOW - 60_000);
  });

  it("does not flip to stale until the bound is passed", () => {
    const atBound = combineStockPrice({
      reading: fresh({ updatedAt: BigInt((NOW - FEED_STALE_AFTER_MS) / 1000) }),
      ngnRate: NGN_RATE,
      nowMs: NOW,
    });
    expect(atBound.stale).toBe(false);

    const pastBound = combineStockPrice({
      reading: fresh({
        updatedAt: BigInt((NOW - FEED_STALE_AFTER_MS) / 1000 - 1),
      }),
      ngnRate: NGN_RATE,
      nowMs: NOW,
    });
    expect(pastBound.stale).toBe(true);
  });

  it("keeps a stale price readable and dated, not hidden", () => {
    const weekendMs = NOW - 3 * FEED_STALE_AFTER_MS;
    const price = combineStockPrice({
      reading: fresh({ updatedAt: BigInt(weekendMs / 1000) }),
      ngnRate: NGN_RATE,
      nowMs: NOW,
    });

    expect(price.stale).toBe(true);
    expect(price.usd).toBeCloseTo(201.23, 8);
    expect(price.ngn).toBeCloseTo(301_845, 6);
    expect(price.updatedAt).toBe(weekendMs);
  });
});

describe("combineStockPrice unusable readings", () => {
  it("rejects a non-positive answer but keeps its timestamp", () => {
    for (const answer of [0n, -1n]) {
      const price = combineStockPrice({
        reading: fresh({ answer }),
        ngnRate: NGN_RATE,
        nowMs: NOW,
      });

      expect(price.usd).toBeNull();
      expect(price.ngn).toBeNull();
      expect(price.unusable).toBe("non-positive-answer");
      expect(price.stale).toBe(true);
      expect(price.updatedAt).toBe(NOW - 60_000);
    }
  });

  it("reports a missing feed without inventing a price", () => {
    const price = combineStockPrice({
      reading: null,
      missingReason: "no-feed",
      ngnRate: NGN_RATE,
      nowMs: NOW,
    });

    expect(price.usd).toBeNull();
    expect(price.unusable).toBe("no-feed");
    expect(price.stale).toBe(true);
    expect(price.updatedAt).toBeNull();
  });

  it("keeps the USD price when only the naira rate is missing", () => {
    const price = combineStockPrice({ reading: fresh(), ngnRate: null, nowMs: NOW });

    expect(price.usd).toBeCloseTo(201.23, 8);
    expect(price.ngn).toBeNull();
    expect(price.stale).toBe(false);
  });

  it("treats a zero updatedAt as never published", () => {
    const price = combineStockPrice({
      reading: fresh({ updatedAt: 0n }),
      ngnRate: NGN_RATE,
      nowMs: NOW,
    });

    expect(price.updatedAt).toBeNull();
    expect(price.stale).toBe(true);
    expect(price.usd).toBeCloseTo(201.23, 8);
  });
});
