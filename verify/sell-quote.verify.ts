import { describe, expect, it } from "vitest";

import {
  KYBERSWAP_ROUTER_ADDRESS,
  KYBERSWAP_ROUTES_URL,
  QUOTE_TTL_MS,
  ROUTER_MISMATCH_DETAIL,
  sameAddress,
} from "@/lib/quote";
import { sleep } from "@/lib/rpc";
import {
  MAX_SELL_TOKEN_UNITS,
  requestSellQuote,
  type SellQuoteResult,
} from "@/lib/sell";
import {
  QUOTABLE_SYMBOLS,
  TOKEN_ADDRESSES,
  USDC_ADDRESS,
} from "@/lib/tokens";

/**
 * The KyberSwap aggregator in the sell direction, against the live API.
 *
 * The mirror of `verify/quote.verify.ts`: `lib/sell.test.ts` pins the
 * reverse mapping against a fixture, which proves the guards and says
 * nothing about whether the fixture still resembles the API — or whether
 * the aggregator routes stock→USDC at all. This file prints what actually
 * comes back.
 *
 * Not part of `npm test`. Real third-party requests, behind
 * `npm run verify:sell-quote`.
 *
 * What it asserts, narrowly:
 *
 * - Each published token gets an answer we can classify — anything but
 *   `failed`. `no-liquidity` passes: depth follows weekly Aerodrome gauge
 *   votes, so a token losing its pool is news about Base, not a broken
 *   build.
 * - A quote that does come back is internally coherent: the amount we sent
 *   is echoed, the USDC out is positive, expiry is exactly `QUOTE_TTL_MS` on.
 * - The router the response names is still the pinned one — the same
 *   assertion that is *supposed* to break. In a sell this address pulls the
 *   *stock* under the user's approval, so a redeploy fails every sell closed
 *   until the pin is verified and moved.
 */

const DELAY_MS = 1_000;

/** 0.01 shares at the tokens' 8 decimals — a couple of dollars, like the buy probe. */
const PROBE_TOKEN_UNITS = 1_000_000n;

/** The fields `interpretSell` reads off `routeSummary`, and what breaks without each. */
const MAPPED_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["tokenIn", "the echo guard cannot confirm we were quoted in the stock"],
  ["amountIn", "the echo guard cannot confirm the amount we sent"],
  ["tokenOut", "the echo guard cannot confirm USDC was priced"],
  ["amountOut", "there is no USDC figure, so there is no quote at all"],
  ["amountInUsd", "the market spread goes blank"],
  ["amountOutUsd", "the market spread goes blank"],
  ["gasUsd", "estimated gas goes blank, which the panel requires visible"],
  ["gas", "no fee in wei, and the low-ETH warning goes quiet"],
  ["gasPrice", "same: no gas price, no fee in wei"],
];

type AggregatorBody = {
  code?: unknown;
  message?: unknown;
  data?: { routeSummary?: Record<string, unknown>; routerAddress?: unknown };
};

function parseBody(raw: string, status: number): AggregatorBody {
  try {
    return JSON.parse(raw) as AggregatorBody;
  } catch {
    console.info(`  HTTP ${status}, not JSON: ${raw.slice(0, 300)}`);
    throw new Error(`aggregator answered HTTP ${status} with non-JSON`);
  }
}

function summarise(result: SellQuoteResult): string {
  if (result.kind !== "quote") return `${result.kind} — ${result.detail}`;

  const { quote } = result;
  const cost =
    quote.executionCostBps === null
      ? "unpriced"
      : `${quote.executionCostBps}bps`;
  const gas = quote.gasUsd === null ? "no estimate" : `$${quote.gasUsd}`;

  return [
    `${quote.sharesIn} shares in`,
    `$${quote.usdOut.toFixed(2)} out`,
    `spread ${cost}`,
    `gas ${gas}`,
    `router ${quote.routerAddress}`,
  ].join(", ");
}

describe("a 0.01-share sale quote for each published token", () => {
  for (const symbol of QUOTABLE_SYMBOLS) {
    it(`${symbol} — ${TOKEN_ADDRESSES[symbol]}`, async () => {
      await sleep(DELAY_MS);

      const result = await requestSellQuote(symbol, PROBE_TOKEN_UNITS);

      console.info(`  ${symbol}: ${result.kind} — ${summarise(result)}`);

      expect(
        result.kind,
        `${symbol}: ${result.kind === "quote" ? "" : result.detail}`,
      ).not.toBe("failed");

      if (result.kind !== "quote") return;

      const { quote } = result;
      expect(quote.symbol, "symbol").toBe(symbol);
      expect(quote.tokenIn, "tokenIn echo").toBe(PROBE_TOKEN_UNITS);
      expect(quote.usdcOut > 0n, "usdcOut").toBe(true);
      expect(quote.usdOut, "usdOut").toBeGreaterThan(0);
      expect(quote.usdPerShare, "usdPerShare").toBeGreaterThan(0);
      expect(quote.expiresAtMs - quote.receivedAtMs, "ttl").toBe(QUOTE_TTL_MS);

      expect(quote.routerAddress.toLowerCase(), "router echo").toBe(
        KYBERSWAP_ROUTER_ADDRESS.toLowerCase(),
      );
    });
  }
});

describe("the routeSummary fields the sell mapping depends on", () => {
  it("prints what an NVDA sale route actually carries", async () => {
    await sleep(DELAY_MS);

    const url = new URL(KYBERSWAP_ROUTES_URL);
    url.searchParams.set("tokenIn", TOKEN_ADDRESSES.NVDA);
    url.searchParams.set("tokenOut", USDC_ADDRESS);
    url.searchParams.set("amountIn", PROBE_TOKEN_UNITS.toString());
    url.searchParams.set("gasInclude", "true");

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-client-id": process.env.KYBERSWAP_CLIENT_ID ?? "bourse",
      },
      cache: "no-store",
    });

    const raw = await response.text();
    const body = parseBody(raw, response.status);

    console.info(
      `  HTTP ${response.status}, code ${String(body.code)}, message ${JSON.stringify(body.message)}`,
    );
    console.info(`  data keys: ${Object.keys(body.data ?? {}).join(", ")}`);

    const summary = body.data?.routeSummary;
    if (summary === undefined) {
      console.info("  no routeSummary in this response");
      return;
    }

    for (const [key, value] of Object.entries(summary)) {
      const rendered = Array.isArray(value)
        ? `[${value.length} legs]`
        : JSON.stringify(value);
      console.info(`  routeSummary.${key} = ${rendered}`);
    }

    for (const [field, consequence] of MAPPED_FIELDS) {
      expect(summary, `routeSummary.${field} is gone: ${consequence}`).toHaveProperty(
        field,
      );
    }

    const router = summary.routerAddress ?? body.data?.routerAddress;

    expect(
      router,
      "no routerAddress anywhere in the response; a sale has nothing to submit to",
    ).toBeTypeOf("string");

    console.info(`  routerAddress = ${JSON.stringify(router)}`);
    console.info(`  pinned in lib/quote.ts = ${KYBERSWAP_ROUTER_ADDRESS}`);

    expect(
      String(router).toLowerCase(),
      `the response names a router other than the pin. Every sell is failing closed with "${ROUTER_MISMATCH_DETAIL}" until the pin is verified and moved.`,
    ).toBe(KYBERSWAP_ROUTER_ADDRESS.toLowerCase());
  });
});

describe("what a refusal actually says", () => {
  it("prints the classification for a sale no pool can fill", async () => {
    await sleep(DELAY_MS);

    // A million shares — far past any holding, against pools holding a
    // couple of million dollars.
    const result = await requestSellQuote("NVDA", MAX_SELL_TOKEN_UNITS);

    console.info(`  1M-share NVDA sale: ${result.kind} — ${summarise(result)}`);

    if (result.kind === "quote") {
      console.info(
        `  priced at ${String(result.quote.executionCostBps)}bps — a real answer at an absurd size`,
      );
      return;
    }

    expect(result.detail, "a refusal with no reason attached").not.toBe("");
  });
});
