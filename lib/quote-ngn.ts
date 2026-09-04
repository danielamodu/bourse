import { computePremiumBps, scaleBigInt, toNgn } from "@/lib/price";
import {
  MAX_QUOTE_USDC_UNITS,
  MIN_QUOTE_USDC_UNITS,
  type Quote,
} from "@/lib/quote";
import { USDC_DECIMALS } from "@/lib/tokens";

/**
 * The naira view of a quote.
 *
 * Kept out of `lib/quote.ts` for two reasons. The rate is polled in the browser,
 * so it is not available where the quote is fetched; and `lib/quote.ts` imports
 * `scaleBigInt` from `lib/price.ts`, so joining naira there would put a cycle
 * between the two modules. Same split as reference prices, where the server reads
 * USD and `withNgnRate` adds naira later.
 *
 * Every field is nullable rather than the whole object being nullable. A missing
 * rate should blank one row, not remove the quote — the shares figure and the
 * price impact are still true without it, and the formatters already render null
 * as a placeholder.
 */
export type NgnQuote = {
  quote: Quote;
  /** What the user pays, in naira. The headline figure. */
  ngnIn: number | null;
  /** Naira per share on this route. The conversion rate the panel shows. */
  ngnPerShare: number | null;
  /** Estimated gas, in naira. */
  gasNgn: number | null;
  /**
   * Premium (positive) or discount (negative) of the execution price against the
   * Chainlink reference, in basis points.
   *
   * This is the first real source for that figure: before a quote there was no
   * traded price to compare, so it rendered blank. It is a comparison against a
   * reference that can be many hours old — the panel captions the reference age
   * beside it, because a premium quoted off a 13-hour-old number is not the
   * precise thing it looks like.
   */
  premiumBps: number | null;
};

/**
 * Adds the naira figures and the premium to a quote. Pure.
 *
 * `referenceUsd` is the Chainlink reference for this token in USD, or null when
 * there is no usable reading — in which case the premium is blank rather than
 * computed against a number we do not have.
 */
export function withNgnQuote(
  quote: Quote,
  usdToNgnRate: number | null,
  referenceUsd: number | null = null,
): NgnQuote {
  return {
    quote,
    ngnIn: toNgn(quote.usdIn, usdToNgnRate),
    ngnPerShare: toNgn(quote.usdPerShare, usdToNgnRate),
    gasNgn: toNgn(quote.gasUsd, usdToNgnRate),
    premiumBps: computePremiumBps(quote.usdPerShare, referenceUsd),
  };
}

/**
 * The quotable order size, in naira, at today's rate.
 *
 * The band itself is denominated in USDC because that is what the aggregator
 * takes, but the person typing sees naira, so "at least $1" has to be said as a
 * naira figure to be usable. Rounds inward on both ends — up on the floor, down
 * on the ceiling — because `ngnToUsdcUnits` floors, and a minimum that converts
 * to one unit under the floor would be a minimum the route rejects.
 *
 * Both null before a rate has been fetched, when there is no honest figure to
 * name.
 */
export function quoteBandNgn(usdToNgnRate: number | null): {
  minNgn: number | null;
  maxNgn: number | null;
} {
  const minNgn = toNgn(scaleBigInt(MIN_QUOTE_USDC_UNITS, USDC_DECIMALS), usdToNgnRate);
  const maxNgn = toNgn(scaleBigInt(MAX_QUOTE_USDC_UNITS, USDC_DECIMALS), usdToNgnRate);

  return {
    minNgn: minNgn === null ? null : Math.ceil(minNgn),
    maxNgn: maxNgn === null ? null : Math.floor(maxNgn),
  };
}
