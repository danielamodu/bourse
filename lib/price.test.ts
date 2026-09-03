import { describe, expect, it } from "vitest";

import {
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

describe("computePremiumBps", () => {
  it("reports a premium and a discount", () => {
    expect(computePremiumBps(202, 200)).toBe(100);
    expect(computePremiumBps(198, 200)).toBe(-100);
    expect(computePremiumBps(200, 200)).toBe(0);
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
