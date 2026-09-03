import { aggregatorV3Abi } from "@/lib/abi";
import {
  combineStockPrice,
  type FeedReading,
  type StockPrice,
} from "@/lib/price";
import { basePublicClient } from "@/lib/rpc";
import { CHAINLINK_FEEDS, STOCK_SYMBOLS, type StockSymbol } from "@/lib/tokens";

/**
 * Reference prices for all 13 tokens, read on the server.
 *
 * Server-side on purpose: `/markets` is a browsing page, so it must not ship a
 * wallet SDK to a user on Nigerian mobile data just to show thirteen numbers.
 * Nothing here touches wagmi.
 *
 * All 26 reads — a `latestRoundData()` and a `decimals()` per feed — go out as a
 * single Multicall3 `eth_call`. Issued individually they would trip
 * `mainnet.base.org`'s rate limit; `batchSize: 0` keeps viem from splitting them
 * back into several requests.
 *
 * The naira figure is left null here. The rate is polled in the browser so it
 * stays live, and `withNgnRate` joins the two.
 */

export type StockPriceMap = Record<StockSymbol, StockPrice>;

/** Two reads per feed, in symbol order: latestRoundData, then decimals. */
const FEED_CONTRACTS = STOCK_SYMBOLS.flatMap((symbol) => [
  {
    address: CHAINLINK_FEEDS[symbol],
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
  } as const,
  {
    address: CHAINLINK_FEEDS[symbol],
    abi: aggregatorV3Abi,
    functionName: "decimals",
  } as const,
]);

type MulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; error: unknown };

export async function readStockPrices(
  nowMs: number = Date.now(),
): Promise<StockPriceMap> {
  const results = await readFeeds();

  return Object.fromEntries(
    STOCK_SYMBOLS.map((symbol, index) => {
      const round = results[index * 2];
      const feedDecimals = results[index * 2 + 1];
      const reading =
        round?.status === "success" && feedDecimals?.status === "success"
          ? toReading(round.result, feedDecimals.result)
          : null;

      return [
        symbol,
        combineStockPrice({
          reading,
          missingReason: "not-read",
          ngnRate: null,
          nowMs,
        }),
      ];
    }),
  ) as StockPriceMap;
}

/**
 * One batched call. A failure returns empty rather than throwing: every card
 * then reads "Price did not load", which is the honest state and also keeps a
 * network problem at build time from failing the build.
 */
async function readFeeds(): Promise<MulticallResult[]> {
  try {
    const results = await basePublicClient().multicall({
      contracts: FEED_CONTRACTS,
      allowFailure: true,
      batchSize: 0,
    });

    return results as unknown as MulticallResult[];
  } catch (error) {
    console.error("[read-prices] Base multicall failed", error);
    return [];
  }
}

/**
 * `latestRoundData` returns
 * `[roundId, answer, startedAt, updatedAt, answeredInRound]`.
 *
 * Checked rather than cast: a malformed response should read as "no price", not
 * as a number we then present to someone about to spend money.
 */
function toReading(round: unknown, feedDecimals: unknown): FeedReading | null {
  if (!Array.isArray(round) || round.length < 4) return null;

  const answer: unknown = round[1];
  const updatedAt: unknown = round[3];

  if (typeof answer !== "bigint" || typeof updatedAt !== "bigint") return null;
  if (typeof feedDecimals !== "number" || !Number.isInteger(feedDecimals)) {
    return null;
  }

  return { answer, updatedAt, decimals: feedDecimals };
}
