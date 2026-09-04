import { computePremiumBps, scaleBigInt, toNgn } from "@/lib/price";
import {
  BOURSE_FEE_BPS,
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
 * execution cost are still true without it, and the formatters already render null
 * as a placeholder.
 *
 * HOW THE FIGURES COMPOSE, because the panel states a total and a total that
 * double-counts would be a lie:
 *
 *   ngnIn      what the user hands over
 *     ├ spreadNgn   part of ngnIn that the market takes
 *     └ feeNgn      part of ngnIn that Bourse takes (zero today)
 *   gasNgn     paid separately, in ETH, on top
 *   totalNgn   ngnIn + gasNgn
 *
 * So the spread and the Bourse fee are named because a user should know where
 * their naira went, not because they are added to it.
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
  /**
   * The market spread as naira, taken as `executionCostBps` of `ngnIn`.
   *
   * Derived from the rounded basis-point figure rather than from the raw dollar
   * legs so that the two figures on that row agree: someone checking ₦525 against
   * 1.05% of ₦50,000 finds the number they were shown. The bps figure rounds up,
   * so this inherits that — at most a basis point over, never under.
   */
  spreadNgn: number | null;
  /**
   * Bourse's cut, in naira. Zero while {@link BOURSE_FEE_BPS} is zero.
   *
   * Zero rather than null when there is no rate yet, because zero naira is zero at
   * every rate. The row reads "None" from it, and that statement does not depend on
   * a rate having arrived.
   */
  feeNgn: number | null;
  /**
   * Everything that leaves the user: `ngnIn` plus the network fee.
   *
   * Null when either part is unknown. A total that silently omits the network fee
   * would understate the cost, and the whole reason this line exists is to be the
   * one figure someone can trust without reading the rest.
   */
  totalNgn: number | null;
};

/**
 * A basis-point share of a naira amount: 105bps of ₦50,000 is ₦525.
 *
 * Null in, null out, so a missing rate propagates rather than becoming a zero that
 * reads as "no cost".
 */
function bpsOfNgn(ngn: number | null, bps: number | null): number | null {
  if (ngn === null || bps === null) return null;
  if (!Number.isFinite(ngn) || !Number.isFinite(bps)) return null;

  const share = (ngn * bps) / 10_000;
  return Number.isFinite(share) ? share : null;
}

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
  const ngnIn = toNgn(quote.usdIn, usdToNgnRate);
  const gasNgn = toNgn(quote.gasUsd, usdToNgnRate);

  return {
    quote,
    ngnIn,
    ngnPerShare: toNgn(quote.usdPerShare, usdToNgnRate),
    gasNgn,
    premiumBps: computePremiumBps(quote.usdPerShare, referenceUsd),
    spreadNgn: bpsOfNgn(ngnIn, quote.executionCostBps),
    feeNgn: BOURSE_FEE_BPS <= 0 ? 0 : bpsOfNgn(ngnIn, BOURSE_FEE_BPS),
    totalNgn: ngnIn === null || gasNgn === null ? null : ngnIn + gasNgn,
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
