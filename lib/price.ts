/**
 * Price math. Pure functions only — no wagmi, no React, no network.
 *
 * The hooks in /hooks read the chain and hand the raw values here. Keeping the
 * arithmetic separate is what makes staleness and conversion testable without a
 * fork or a rendered component.
 */

/**
 * A Chainlink reading older than this is treated as not current.
 *
 * These feeds stop publishing entirely while US markets are closed — no
 * heartbeat, frozen `updatedAt` — while the tokens keep trading 24/7. So a
 * weekend reading is expected to be stale, and 24h is the bound that
 * distinguishes "markets are shut" from "this feed has a problem".
 */
export const FEED_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Raw `latestRoundData()` output plus the feed's own `decimals()`. */
export type FeedReading = {
  answer: bigint;
  /** Unix seconds, as the contract returns it. */
  updatedAt: bigint;
  decimals: number;
};

export type FeedUnusableReason =
  /** No feed address in the registry yet. */
  | "no-feed"
  /** The multicall for this feed failed or has not resolved. */
  | "not-read"
  /** Feed returned zero or negative — Chainlink says treat these as invalid. */
  | "non-positive-answer"
  /** decimals() was outside a range we can scale safely. */
  | "bad-decimals";

export type StockPrice = {
  /** Reference price in USD, or null when there is no number we can vouch for. */
  usd: number | null;
  /** The same price in naira, or null when either input is unusable. */
  ngn: number | null;
  /** Unix ms of the feed's last publish, whenever the feed reported one. */
  updatedAt: number | null;
  /**
   * True unless we hold a price we can vouch for as current. Deliberately a
   * superset of "old": a caller that only checks this flag can never present a
   * price as live when it isn't.
   */
  stale: boolean;
  /** Why there is no usable price. Null when `usd` is a number. */
  unusable: FeedUnusableReason | null;
  /** Premium (positive) or discount (negative) vs the reference, in basis points. */
  premiumBps: number | null;
};

const MAX_SAFE_DECIMALS = 36;

/**
 * Converts a fixed-point on-chain integer to a JS number.
 *
 * Splits whole and fractional parts before touching Number so a large value
 * does not lose its integer part to float rounding. Returns NaN for a decimals
 * value we cannot scale, which callers treat as unusable.
 */
export function scaleBigInt(value: bigint, decimals: number): number {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_SAFE_DECIMALS
  ) {
    return Number.NaN;
  }

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = Number(absolute / divisor);
  const fraction = Number(absolute % divisor) / Number(divisor);
  const scaled = whole + fraction;

  return negative ? -scaled : scaled;
}

/** Unix seconds from a feed to unix ms, or null when implausible. */
function toMillis(updatedAt: bigint): number | null {
  if (updatedAt <= 0n) return null;
  const ms = Number(updatedAt) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Premium (positive) or discount (negative) of a traded price against the
 * reference, in basis points. Null when either side is unusable.
 */
export function computePremiumBps(
  marketUsd: number | null,
  referenceUsd: number | null,
): number | null {
  if (marketUsd === null || referenceUsd === null) return null;
  if (!Number.isFinite(marketUsd) || !Number.isFinite(referenceUsd)) return null;
  if (referenceUsd <= 0) return null;

  return Math.round(((marketUsd - referenceUsd) / referenceUsd) * 10_000);
}

/** USD to naira. Null unless both inputs are usable. */
export function toNgn(usd: number | null, ngnRate: number | null): number | null {
  if (usd === null || ngnRate === null) return null;
  if (!Number.isFinite(usd) || !Number.isFinite(ngnRate) || ngnRate <= 0) {
    return null;
  }

  const ngn = usd * ngnRate;
  return Number.isFinite(ngn) ? ngn : null;
}

export type CombineInput = {
  /** Null when the registry has no feed address, or the read failed. */
  reading: FeedReading | null;
  /** Why `reading` is null, when we know. Defaults to "not-read". */
  missingReason?: FeedUnusableReason;
  ngnRate: number | null;
  nowMs: number;
  /**
   * Live traded price in USD, for the premium. Null until there is a quote
   * source — the premium is blank rather than reported as zero.
   */
  marketUsd?: number | null;
};

/** Builds the per-token price a card renders, from one feed reading. */
export function combineStockPrice({
  reading,
  missingReason = "not-read",
  ngnRate,
  nowMs,
  marketUsd = null,
}: CombineInput): StockPrice {
  if (reading === null) {
    return unusable(missingReason, null);
  }

  const updatedAt = toMillis(reading.updatedAt);

  if (reading.answer <= 0n) {
    return unusable("non-positive-answer", updatedAt);
  }

  const usd = scaleBigInt(reading.answer, reading.decimals);

  if (!Number.isFinite(usd) || usd <= 0) {
    return unusable("bad-decimals", updatedAt);
  }

  const stale = updatedAt === null || nowMs - updatedAt > FEED_STALE_AFTER_MS;

  return {
    usd,
    ngn: toNgn(usd, ngnRate),
    updatedAt,
    stale,
    unusable: null,
    premiumBps: computePremiumBps(marketUsd, usd),
  };
}

function unusable(
  reason: FeedUnusableReason,
  updatedAt: number | null,
): StockPrice {
  return {
    usd: null,
    ngn: null,
    updatedAt,
    stale: true,
    unusable: reason,
    premiumBps: null,
  };
}

/**
 * Fills in the naira figure once a rate is known.
 *
 * The chain reads happen on the server; the naira rate is polled in the browser
 * so it stays live and survives a failed fetch. This is the join between them —
 * pure, so the server-rendered price object is never mutated and the conversion
 * stays testable.
 */
export function withNgnRate(
  price: StockPrice,
  ngnRate: number | null,
): StockPrice {
  const ngn = toNgn(price.usd, ngnRate);
  if (ngn === price.ngn) return price;
  return { ...price, ngn };
}
