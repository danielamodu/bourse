import {
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { aggregatorV3Abi } from "@/lib/abi";
import { requestRoute } from "@/lib/build";
import { formatFeedAge } from "@/lib/format";
import {
  combineStockPrice,
  computePremiumBps,
  scaleBigInt,
  type FeedReading,
} from "@/lib/price";
import { toBigInt } from "@/lib/quote";
import {
  READ_DELAY_MS,
  baseRpcUrls,
  sleep,
} from "@/lib/rpc";
import {
  QUOTABLE_SYMBOLS,
  STOCK_TOKENS,
  TOKEN_DECIMALS,
  type QuotableSymbol,
} from "@/lib/tokens";
import { PROBE_USDC_UNITS } from "@/lib/tradeability";

/**
 * The portfolio's valuation arithmetic, checked against a live market.
 *
 * Not part of `npm test`. Live aggregator plus live chain reads, so it sits
 * behind `npm run verify:multiplier` and is run deliberately — after a change
 * to the scaling in `lib/price.ts`, the token registry, or the quote
 * mapping.
 *
 * NO FUNDS, NO APPROVALS, NO TRANSACTIONS. Reads and quotes only: one
 * KyberSwap buy quote per token and two `eth_call`s per feed
 * (`latestRoundData` and `decimals`). Nothing is signed, so nothing can be
 * submitted.
 *
 * What it proves, per token: valuing the quoted token units the way the
 * portfolio values a balance — shares via `scaleBigInt` at the token's
 * registry decimals, times the Chainlink reference via `combineStockPrice`,
 * both real functions, never reimplemented here — produces a USD figure
 * within a factor of two of what the pool actually priced those same units
 * at (`amountOutUsd`). The band tolerates a real market premium or discount
 * and fails decisively on a power-of-ten decimal-scaling bug, which is the
 * only thing this guards. A misplaced decimal shifts the ratio by 10x or
 * more; no market condition does.
 *
 * The quote size is `PROBE_USDC_UNITS` — the same $30 ticket the markets
 * page probes tradeability and premium at — not a new size invented for this
 * script. Token addresses and feed addresses both resolve through the
 * `STOCK_TOKENS` registry, the same resolution the app uses; no address is
 * transcribed here.
 */

const DELAY_MS = 1_000;

/** The hard gate: a real premium fits comfortably; a decimal bug cannot. */
const RATIO_MIN = 0.5;
const RATIO_MAX = 2.0;

/**
 * Cross-check tolerance: the premium implied by the ratio against the
 * spread the quote itself reported. A gap past this prints a flag, not a
 * failure — the two measure the DEX/reference gap through different legs,
 * so small divergence is structure, not news.
 */
const PREMIUM_DIVERGENCE_BPS = 300;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let callCount = 0;

/**
 * Every endpoint available, dedicated first — the same rotation
 * `verify/chain.verify.ts` uses. `BASE_RPC_URL` leads when it is set;
 * otherwise the public three share the reads.
 */
const ENDPOINTS = baseRpcUrls();

async function fromAnyEndpoint<T>(
  label: string,
  read: (url: string) => Promise<T>,
): Promise<{ url: string; value: T }> {
  const start = callCount++;
  const failures: string[] = [];

  for (let offset = 0; offset < ENDPOINTS.length; offset += 1) {
    const url = ENDPOINTS[(start + offset) % ENDPOINTS.length];
    if (url === undefined) continue;

    await sleep(READ_DELAY_MS);

    try {
      return { url, value: await read(url) };
    } catch (error) {
      failures.push(`${url} — ${describeError(error)}`);
    }
  }

  throw new Error(
    `could not read ${label} from any endpoint:\n  ${failures.join("\n  ")}`,
  );
}

async function rpcResult(url: string, to: string, data: Hex): Promise<Hex> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(`${url} returned ${body.error.message ?? "an error"}`);
    }
    if (typeof body.result !== "string" || !body.result.startsWith("0x")) {
      throw new Error(`${url} returned no result`);
    }

    return body.result as Hex;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The feed reading through the real ABI and the real validity path: the
 * call data is encoded from `aggregatorV3Abi`, and the answer is admitted
 * through `combineStockPrice`, which is what rejects a non-positive answer
 * or an unreadable decimals on the app's own screens.
 */
async function readFeedPrice(
  symbol: QuotableSymbol,
): Promise<{ usd: number; age: string | null; url: string }> {
  const feed = STOCK_TOKENS[symbol].feedAddress;

  const roundData = encodeFunctionData({
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
  });
  const decimalsData = encodeFunctionData({
    abi: aggregatorV3Abi,
    functionName: "decimals",
  });

  const { value: roundRaw, url } = await fromAnyEndpoint(
    `latestRoundData at ${feed}`,
    (rpcUrl) => rpcResult(rpcUrl, feed, roundData),
  );
  const { value: decimalsRaw } = await fromAnyEndpoint(
    `decimals at ${feed}`,
    (rpcUrl) => rpcResult(rpcUrl, feed, decimalsData),
  );

  // Decoded with the ABI, never by slice offsets: the tuple shape is the
  // contract's, not ours to restate.
  const [, answer, , updatedAt] = decodeFunctionResult({
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
    data: roundRaw,
  }) as unknown as [bigint, bigint, bigint, bigint, bigint];
  // A single-output function decodes to the bare value, not a tuple.
  const decimals = decodeFunctionResult({
    abi: aggregatorV3Abi,
    functionName: "decimals",
    data: decimalsRaw,
  }) as unknown as number;

  const reading: FeedReading = {
    answer,
    updatedAt,
    decimals: typeof decimals === "number" ? decimals : Number(decimals),
  };

  const nowMs = Date.now();
  const price = combineStockPrice({ reading, ngnRate: null, nowMs });

  expect(
    price.unusable,
    `${symbol}: feed reading unusable (${price.unusable}) — a reference that cannot be vouched for cannot anchor this check`,
  ).toBeNull();
  expect(
    price.usd,
    `${symbol}: feed scaled to a non-positive USD figure`,
  ).not.toBeNull();
  if (price.usd === null) throw new Error(`${symbol}: unreachable`);

  const updatedAtMs =
    reading.updatedAt > 0n ? Number(reading.updatedAt) * 1000 : null;
  const age =
    updatedAtMs === null ? null : formatFeedAge(updatedAtMs, nowMs);

  return { usd: price.usd, age, url };
}

describe("portfolio arithmetic against the live market, per token", () => {
  for (const symbol of QUOTABLE_SYMBOLS) {
    it(`${symbol}: valuing the quoted units at the reference lands near the pool price`, async () => {
      await sleep(DELAY_MS);

      const { result, routeSummary } = await requestRoute(
        symbol,
        PROBE_USDC_UNITS,
      );

      if (result.kind === "no-liquidity") {
        // Depth follows weekly Aerodrome gauge votes. No route today is news
        // about Base rather than broken arithmetic, and `verify:quote` is
        // where a missing route is judged.
        console.info(`  ${symbol}: no route today: ${result.detail}`);
        return;
      }

      expect(result.kind, result.kind === "quote" ? "" : result.detail).toBe(
        "quote",
      );
      if (result.kind !== "quote") return;

      const { quote } = result;

      // The summary's amountOut is the same field the quote was built from —
      // read it raw here and require it to agree with the validated quote.
      const summaryOut =
        routeSummary === null ? null : toBigInt(routeSummary.amountOut);
      expect(
        summaryOut,
        `${symbol}: routeSummary.amountOut disagrees with the quoted unitsOut`,
      ).toBe(quote.unitsOut);
      if (summaryOut === null) return;

      const amountOutUsdRaw =
        routeSummary === null ? null : routeSummary.amountOutUsd;
      const amountOutUsd =
        typeof amountOutUsdRaw === "number"
          ? amountOutUsdRaw
          : Number(amountOutUsdRaw);
      expect(
        Number.isFinite(amountOutUsd) && amountOutUsd > 0,
        `${symbol}: amountOutUsd unreadable (${String(amountOutUsdRaw)}) — nothing to compare against`,
      ).toBe(true);

      const { usd: feedUsd, age } = await readFeedPrice(symbol);

      // The portfolio's exact arithmetic, with its exact functions: units to
      // shares at the registry decimals, times the reference. Nothing here
      // divides by a literal power of ten.
      const shares = scaleBigInt(quote.unitsOut, TOKEN_DECIMALS[symbol]);
      const ourUsd = shares * feedUsd;
      const ratio = ourUsd / amountOutUsd;

      // The cross-check: the same gap the markets page shows as a premium,
      // recomputed here from the ratio through the real premium function and
      // set beside the spread the quote itself reported.
      const dexUsdPerShare = amountOutUsd / shares;
      const impliedPremiumBps = computePremiumBps(dexUsdPerShare, feedUsd);
      const reportedSpreadBps = quote.executionCostBps;
      const divergence =
        impliedPremiumBps === null || reportedSpreadBps === null
          ? null
          : Math.abs(impliedPremiumBps - reportedSpreadBps);

      console.info(
        `  ${symbol}: out ${shares} shares @ reference $${feedUsd}` +
          `${age === null ? "" : ` (${age})`} = $${ourUsd.toFixed(4)} ours vs $${amountOutUsd.toFixed(4)} pool` +
          ` — ratio ${ratio.toFixed(4)}` +
          ` (implied premium ${impliedPremiumBps === null ? "unpriced" : `${impliedPremiumBps}bps`}` +
          ` vs reported spread ${reportedSpreadBps === null ? "unpriced" : `${reportedSpreadBps}bps`})`,
      );

      if (divergence !== null && divergence > PREMIUM_DIVERGENCE_BPS) {
        console.info(
          `  ${symbol}: FLAG — implied premium and reported spread differ by ${divergence}bps; ` +
            "both measure the DEX/reference gap through different legs, so investigate before trusting either here.",
        );
      }

      expect(
        ratio >= RATIO_MIN && ratio <= RATIO_MAX,
        `${symbol}: ratio ${ratio} outside [${RATIO_MIN}, ${RATIO_MAX}] — a decimal-scaling bug moves this by 10x or more, no market condition does`,
      ).toBe(true);
    });
  }
});
