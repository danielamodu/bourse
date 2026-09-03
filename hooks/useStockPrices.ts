"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { base } from "wagmi/chains";

import { useNGNRate } from "./useNGNRate";
import { aggregatorV3Abi } from "@/lib/abi";
import {
  combineStockPrice,
  type FeedReading,
  type StockPrice,
} from "@/lib/price";
import { CHAINLINK_FEEDS, STOCK_SYMBOLS, type StockSymbol } from "@/lib/tokens";

/**
 * Reference price per token, in USD and naira — the client-side path.
 *
 * Used on the trade route, where the wallet stack is loaded anyway. `/markets`
 * does not use this: a browsing page has no business shipping wagmi to someone
 * on mobile data, so it reads server-side through `lib/read-prices.ts`. Both
 * paths hand the same raw values to the same pure `combineStockPrice`.
 *
 * One multicall covers every feed: `latestRoundData()` and `decimals()` for each
 * of the 13, batched into a single `eth_call`. Issued individually those 26 reads
 * would trip Base's public rate limit.
 *
 * Feed freshness varies per token — 29 minutes to nearly 15 hours on the same
 * afternoon — so staleness is per feed, read from its own `updatedAt`. It is
 * surfaced, never hidden, and never presented as current.
 */

/** Two reads per feed, in symbol order: latestRoundData, then decimals. */
const FEED_CONTRACTS = STOCK_SYMBOLS.flatMap((symbol) => [
  {
    address: CHAINLINK_FEEDS[symbol],
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
    chainId: base.id,
  } as const,
  {
    address: CHAINLINK_FEEDS[symbol],
    abi: aggregatorV3Abi,
    functionName: "decimals",
    chainId: base.id,
  } as const,
]);

const PRICE_POLL_MS = 60_000;

export type StockPrices = {
  prices: Record<StockSymbol, StockPrice>;
  /** True until there is something to render. */
  loading: boolean;
  error: Error | null;
  /** The naira rate the USD prices were converted at. */
  ngnRate: number | null;
  /** True when the naira rate itself is unconfirmed. */
  ngnRateStale: boolean;
};

export function useStockPrices(): StockPrices {
  const { rate, loading: rateLoading, error: rateError, isStale } = useNGNRate();

  const {
    data,
    isLoading: readsLoading,
    error: readsError,
    dataUpdatedAt,
  } = useReadContracts({
    contracts: FEED_CONTRACTS,
    allowFailure: true,
    query: { refetchInterval: PRICE_POLL_MS },
  });

  const prices = useMemo(() => {
    const nowMs = Date.now();

    return Object.fromEntries(
      STOCK_SYMBOLS.map((symbol, index) => {
        const round = data?.[index * 2];
        const feedDecimals = data?.[index * 2 + 1];
        const reading =
          round?.status === "success" && feedDecimals?.status === "success"
            ? toReading(round.result, feedDecimals.result)
            : null;

        return [
          symbol,
          combineStockPrice({
            reading,
            missingReason: "not-read",
            ngnRate: rate,
            nowMs,
          }),
        ];
      }),
    ) as Record<StockSymbol, StockPrice>;
    // dataUpdatedAt changes whenever the multicall resolves.
  }, [data, dataUpdatedAt, rate]);

  return {
    prices,
    loading: (readsLoading || rateLoading) && rate === null,
    error: readsError ?? rateError ?? null,
    ngnRate: rate,
    ngnRateStale: isStale,
  };
}

/**
 * `latestRoundData` returns
 * `[roundId, answer, startedAt, updatedAt, answeredInRound]`.
 *
 * Checked rather than cast: a malformed response should read as "no price", not
 * as a number we then show to someone about to spend money.
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
