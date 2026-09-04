import { mapKeys } from "@/lib/map-keys";
import {
  EXECUTION_COST_BUDGET_BPS,
  requestQuote,
  type QuoteResult,
} from "@/lib/quote";
import {
  QUOTABLE_SYMBOLS,
  STOCK_SYMBOLS,
  STOCK_TOKENS,
  type StockSymbol,
} from "@/lib/tokens";

/**
 * Which stocks can actually be bought, asked rather than asserted.
 *
 * There is no tradeability flag in the registry any more. Depth on Base is set by
 * weekly Aerodrome gauge votes, so a hand-written list is wrong by construction —
 * it is a measurement with an expiry date, stored as if it were a property. This
 * module makes the measurement instead: request a quote at a representative
 * ticket and see what comes back.
 *
 * Four answers, because there are four genuinely different situations and the
 * page says something different about each. Collapsing them is how a page ends up
 * telling a user a stock has no market when in fact our own request timed out.
 */
export type Tradeability =
  /** A quote came back, priced inside the execution-cost budget. */
  | "tradeable"
  /** The aggregator answered: no route, or a price we will not stand behind. */
  | "not-tradeable"
  /** We could not find out — the request failed, or the cost was unpriced. */
  | "unknown"
  /** No address published, so there is nothing to ask about. */
  | "unpublished";

/**
 * What one probe learned about one token.
 *
 * The verdict is the part the grid groups by. The two figures beside it are the
 * reason the probe is worth more than a boolean: a quote is a traded price, so it
 * is also the first honest source for the premium against the Chainlink
 * reference, which until now had nothing to compare and rendered blank
 * everywhere.
 *
 * Both are measured at {@link PROBE_USDC_UNITS}, not at the user's amount. A card
 * showing them is showing what a small ticket costs today — which is the useful
 * thing on a browsing page, and is re-quoted at the real size before anyone buys.
 */
export type TradeabilityReport = {
  verdict: Tradeability;
  /** Execution price at the probe size, in USD per share. Null without a quote. */
  usdPerShare: number | null;
  /**
   * What crossing the market costs at the probe size, in bps. Null when the quote
   * did not price it. Spread and fees rather than size-dependent slippage — see
   * `Quote.executionCostBps`.
   */
  executionCostBps: number | null;
};

export type TradeabilityReports = Record<StockSymbol, TradeabilityReport>;

/**
 * The ticket the probe measures at: $30, roughly ₦50,000.
 *
 * Cost can vary with order size, so the question "is this tradeable" is only
 * answerable at some size. A real Bourse ticket is small enough to be noise in
 * even a shallow pool, which is what makes a failure at this size meaningful
 * rather than a symptom of asking too much.
 */
export const PROBE_USDC_UNITS = 30_000_000n;

/**
 * Turns one quote result into one verdict.
 *
 * Exported so it can be tested against every branch without a network, and so the
 * trade panel can reach the same verdict from the user's own quote instead of
 * re-deriving the rule.
 */
export function classifyQuote(result: QuoteResult): Tradeability {
  // Our failure, not the market's. Saying "no market" here would be a claim we
  // have not earned.
  if (result.kind === "failed") return "unknown";
  if (result.kind === "no-liquidity") return "not-tradeable";

  const cost = result.quote.executionCostBps;

  // A route we cannot price is a route we cannot offer: CLAUDE.md requires the
  // cost of a trade to be visible on every buy, and unknown is not a figure.
  if (cost === null) return "unknown";

  return cost <= EXECUTION_COST_BUDGET_BPS ? "tradeable" : "not-tradeable";
}

/**
 * The full report for one quote result: the verdict plus the figures behind it.
 *
 * Split from {@link classifyQuote} so the rule that decides what a user may buy
 * stays one readable function, testable on its own.
 */
export function reportQuote(result: QuoteResult): TradeabilityReport {
  const verdict = classifyQuote(result);

  if (result.kind !== "quote") {
    return { verdict, usdPerShare: null, executionCostBps: null };
  }

  return {
    verdict,
    usdPerShare: result.quote.usdPerShare,
    executionCostBps: result.quote.executionCostBps,
  };
}

export type ProbeOptions = {
  /** Injected in tests. Never reaches the network from `npm test`. */
  fetchImpl?: typeof fetch;
  usdcIn?: bigint;
};

/**
 * Probes all four published tokens and reports on all thirteen.
 *
 * Four requests, issued together. That is four, not thirteen: the nine without a
 * published address are answered from the registry without a request, since there
 * is no address to put in one.
 *
 * Callers are expected to cache this — `app/markets/page.tsx` wraps it in
 * `unstable_cache`, so concurrent page views share one round of probing rather
 * than each firing their own.
 */
export async function probeTradeability(
  options: ProbeOptions = {},
): Promise<TradeabilityReports> {
  const usdcIn = options.usdcIn ?? PROBE_USDC_UNITS;

  const probed = await Promise.all(
    QUOTABLE_SYMBOLS.map(async (symbol) => {
      const result = await requestQuote(symbol, usdcIn, {
        fetchImpl: options.fetchImpl,
      });

      if (result.kind !== "quote") {
        console.info(
          `[tradeability] ${symbol}: ${result.kind} — ${result.detail}`,
        );
      }

      return [symbol, reportQuote(result)] as const;
    }),
  );

  const reports = new Map<string, TradeabilityReport>(probed);

  return mapKeys(
    STOCK_SYMBOLS,
    (symbol): TradeabilityReport => reports.get(symbol) ?? UNPUBLISHED,
  );
}

/** The report for a token with no address to ask about. */
const UNPUBLISHED: TradeabilityReport = {
  verdict: "unpublished",
  usdPerShare: null,
  executionCostBps: null,
};

/**
 * The reports to render before any probe has run.
 *
 * The nine without a published address are still `unpublished` — that is a
 * registry fact and no request would change it. The four that could be quoted are
 * `unknown`, because not having asked is not the same as having been told no.
 */
export function unknownTradeability(): TradeabilityReports {
  return mapKeys(
    STOCK_SYMBOLS,
    (symbol): TradeabilityReport =>
      STOCK_TOKENS[symbol].address === null
        ? UNPUBLISHED
        : { verdict: "unknown", usdPerShare: null, executionCostBps: null },
  );
}
