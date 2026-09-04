import { describe, expect, it } from "vitest";

import {
  EXECUTION_COST_BUDGET_BPS,
  KYBERSWAP_ROUTER_ADDRESS,
  KYBERSWAP_ROUTES_URL,
  MAX_QUOTE_USDC_UNITS,
  QUOTE_TTL_MS,
  ROUTER_MISMATCH_DETAIL,
  requestQuote,
  type QuoteResult,
} from "@/lib/quote";
import { sleep } from "@/lib/rpc";
import {
  QUOTABLE_SYMBOLS,
  TOKEN_ADDRESSES,
  USDC_ADDRESS,
} from "@/lib/tokens";
import { classifyQuote, PROBE_USDC_UNITS } from "@/lib/tradeability";

/**
 * The KyberSwap aggregator, against the live API.
 *
 * Not part of `npm test`. This makes real third-party requests, so it sits behind
 * `npm run verify:quote` and is run deliberately — after a change to the request,
 * to the `routeSummary` mapping, or to `NO_ROUTE_MESSAGE`.
 *
 * Why it exists. `lib/quote.ts` maps a response whose field names came from
 * KyberSwap's docs and one hand-read reply. `lib/quote.test.ts` pins that mapping
 * against a fixture, which proves our arithmetic and says nothing about whether
 * the fixture still resembles the API. This file is the other half: it prints what
 * actually comes back, so the fixture can be corrected when it drifts.
 *
 * What it asserts, narrowly:
 *
 * - Each published token gets an answer we can classify — anything but `failed`.
 *   `no-liquidity` passes. Depth follows weekly Aerodrome gauge votes, so a token
 *   losing its pool is news about Base, not a broken build. `failed` is ours:
 *   transport, or a reply we could not read.
 * - A quote that does come back is internally coherent: the amount we sent is
 *   echoed, the share count is positive, expiry is exactly `QUOTE_TTL_MS` on.
 * - The router the response names is still the pinned one. This is the assertion
 *   that is *supposed* to break: `KYBERSWAP_ROUTER_ADDRESS` is the spender of a
 *   USDC allowance in Part B, so if KyberSwap redeploys, every quote fails closed
 *   in production and this file is where the new address gets read and checked
 *   before the pin moves. A red here is work to do, not a flaky test.
 *
 * It does not assert which tokens are tradeable, and must not start to. That is
 * derived at runtime for the same reason a hardcoded list would be wrong here.
 */

/** A second between requests. Nothing here is in a hurry. */
const DELAY_MS = 1_000;

/** The envelope, as far as the mapping cares about it. */
type AggregatorBody = {
  code?: unknown;
  message?: unknown;
  data?: { routeSummary?: Record<string, unknown>; routerAddress?: unknown };
};

/** The fields `interpret` reads off `routeSummary`, and what breaks without each. */
const MAPPED_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["tokenIn", "the echo guard cannot confirm we were quoted in USDC"],
  ["amountIn", "the echo guard cannot confirm the amount we sent"],
  ["tokenOut", "the echo guard cannot confirm which token was priced"],
  ["amountOut", "there is no share count, so there is no quote at all"],
  ["amountInUsd", "the market spread goes blank, and no buy affordance renders"],
  ["amountOutUsd", "the market spread goes blank, and no buy affordance renders"],
  ["gasUsd", "estimated gas goes blank, which CLAUDE.md requires visible"],
];

/** Parses the envelope, printing whatever came back if it is not JSON. */
function parseBody(raw: string, status: number): AggregatorBody {
  try {
    return JSON.parse(raw) as AggregatorBody;
  } catch {
    console.info(`  HTTP ${status}, not JSON: ${raw.slice(0, 300)}`);
    throw new Error(`aggregator answered HTTP ${status} with non-JSON`);
  }
}

/** The whole result on one line, for the console. */
function summarise(result: QuoteResult): string {
  if (result.kind !== "quote") return `${result.kind} — ${result.detail}`;

  const { quote } = result;
  const cost =
    quote.executionCostBps === null
      ? "unpriced"
      : `${quote.executionCostBps}bps`;
  const gas = quote.gasUsd === null ? "no estimate" : `$${quote.gasUsd}`;

  return [
    `${quote.shares} shares`,
    `$${quote.usdPerShare.toFixed(2)}/share`,
    // "spread", not "impact": this is the gap between the two USD legs, which is
    // pool fee and quote-vs-reference disagreement, and is near enough
    // size-independent. Naming it impact overstated what it measures.
    `spread ${cost}`,
    `gas ${gas}`,
    // Printed on every line, even though `interpret` already refused anything that
    // did not match the pin — the address is the one figure here worth reading with
    // your own eyes, because it is what a user's USDC allowance will name.
    `router ${quote.routerAddress}`,
  ].join(", ");
}

/**
 * One probe-sized quote per published token.
 *
 * One test each, so a failure names the token. Serialised with a delay in front of
 * every request — four requests is nothing, but the same courtesy the RPC reads
 * get costs nothing either.
 */
describe("a $30 quote for each published token", () => {
  for (const symbol of QUOTABLE_SYMBOLS) {
    it(`${symbol} — ${TOKEN_ADDRESSES[symbol]}`, async () => {
      await sleep(DELAY_MS);

      const result = await requestQuote(symbol, PROBE_USDC_UNITS);

      console.info(
        `  ${symbol}: ${classifyQuote(result)} — ${summarise(result)}`,
      );

      expect(
        result.kind,
        `${symbol}: ${result.kind === "quote" ? "" : result.detail}`,
      ).not.toBe("failed");

      if (result.kind !== "quote") return;

      const { quote } = result;
      expect(quote.symbol, "symbol").toBe(symbol);
      expect(quote.usdcIn, "usdcIn echo").toBe(PROBE_USDC_UNITS);
      expect(quote.usdIn, "usdIn").toBeCloseTo(30, 6);
      expect(quote.unitsOut > 0n, "unitsOut").toBe(true);
      expect(quote.shares, "shares").toBeGreaterThan(0);
      expect(quote.usdPerShare, "usdPerShare").toBeGreaterThan(0);
      expect(quote.expiresAtMs - quote.receivedAtMs, "ttl").toBe(QUOTE_TTL_MS);

      // Belt and braces. `interpret` already refused any route naming another
      // router, so a `quote` here cannot carry a mismatch — this restates it as an
      // assertion so that a future change loosening the guard fails a live test as
      // well as an offline one. Lowercased on both sides: checksum casing is
      // cosmetic and KyberSwap returns this address lowercase.
      expect(quote.routerAddress.toLowerCase(), "router echo").toBe(
        KYBERSWAP_ROUTER_ADDRESS.toLowerCase(),
      );
    });
  }
});

/**
 * The field names, printed and then checked.
 *
 * This is the drift this file exists to catch: a rename upstream turns every
 * mapped figure into `undefined`, which `interpret` reads as an unpriced route and
 * the grid reads as "unknown" — a silent downgrade, not an error. The fixture in
 * `lib/quote.test.ts` has to be corrected against whatever prints here.
 */
describe("the routeSummary fields the mapping depends on", () => {
  it("prints what an NVDA route actually carries", async () => {
    await sleep(DELAY_MS);

    const url = new URL(KYBERSWAP_ROUTES_URL);
    url.searchParams.set("tokenIn", USDC_ADDRESS);
    url.searchParams.set("tokenOut", TOKEN_ADDRESSES.NVDA);
    url.searchParams.set("amountIn", PROBE_USDC_UNITS.toString());
    url.searchParams.set("gasInclude", "true");

    // The same headers `lib/quote.ts` sends. `x-client-id` is rate-limit
    // attribution rather than a credential, which is why it has a default.
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-client-id": process.env.KYBERSWAP_CLIENT_ID ?? "bourse",
      },
      cache: "no-store",
    });

    // Read as text and parse it ourselves. If the aggregator answers with an HTML
    // error page, showing what it said is the entire point of this test.
    const raw = await response.text();
    const body = parseBody(raw, response.status);

    console.info(
      `  HTTP ${response.status}, code ${String(body.code)}, message ${JSON.stringify(body.message)}`,
    );
    console.info(`  data keys: ${Object.keys(body.data ?? {}).join(", ")}`);

    const summary = body.data?.routeSummary;
    if (summary === undefined) {
      // No route today. Nothing to compare the fixture against, and not a failure
      // of the mapping — the suite above is where a missing route is judged.
      console.info("  no routeSummary in this response");
      return;
    }

    for (const [key, value] of Object.entries(summary)) {
      // `route` is the leg-by-leg path and runs to hundreds of lines. Its size is
      // the only part worth printing; every other field is small.
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

    // Read off the summary with the envelope as fallback, so this passes wherever
    // KyberSwap chooses to put it — and fails if it stops sending it at all.
    const router = summary.routerAddress ?? body.data?.routerAddress;

    expect(
      router,
      "no routerAddress anywhere in the response; Part B has nothing to submit to",
    ).toBeTypeOf("string");

    console.info(`  routerAddress = ${JSON.stringify(router)}`);
    console.info(`  pinned in lib/quote.ts = ${KYBERSWAP_ROUTER_ADDRESS}`);

    // The one assertion here that is meant to break one day. If KyberSwap redeploys
    // its router, the app stops quoting entirely — `interpret` fails closed rather
    // than granting an allowance to an address the response chose — and this line,
    // with the two values printed above it, is the whole diagnosis. Moving the pin
    // is a deliberate act: read the new address here, confirm it has bytecode in
    // `verify:chain`, then change the constant. Never copy it out of a response.
    expect(
      String(router).toLowerCase(),
      `the response names a router other than the pin. Every quote is failing closed with "${ROUTER_MISMATCH_DETAIL}" until the pin is verified and moved.`,
    ).toBe(KYBERSWAP_ROUTER_ADDRESS.toLowerCase());
  });
});

/**
 * What a refusal actually says.
 *
 * `NO_ROUTE_MESSAGE` in `lib/quote.ts` decides whether a rejection reads to the
 * user as "this stock cannot be bought here" or as "we could not get a price, try
 * again". It is narrow on purpose, and may only be widened against wording seen
 * printed here — guessing at upstream text is how a failed request ends up telling
 * someone a market does not exist.
 */
describe("what a refusal actually says", () => {
  it("prints the classification for an order no pool can fill", async () => {
    await sleep(DELAY_MS);

    // $1,000,000 of one stock — the top of our own band, against a pool holding a
    // couple of million dollars.
    const result = await requestQuote("NVDA", MAX_QUOTE_USDC_UNITS);

    console.info(
      `  $1,000,000 NVDA: ${classifyQuote(result)} — ${summarise(result)}`,
    );

    if (result.kind === "quote") {
      // A route at this size is a real answer and not a failure of this check. The
      // cost is the part worth reading: against a 3% budget it should be vast, and
      // `classifyQuote` above should already say `not-tradeable`. This is also the
      // one place the figure behaves like impact rather than spread — $1,000,000
      // against a $2.5M pool is genuinely size-dependent, which a ₦50,000 ticket
      // never is.
      console.info(
        `  priced at ${String(result.quote.executionCostBps)}bps against a ${EXECUTION_COST_BUDGET_BPS}bps budget`,
      );
      return;
    }

    // Whatever it is, it carries a reason. A refusal we cannot log is a refusal we
    // cannot classify next time.
    expect(result.detail, "a refusal with no reason attached").not.toBe("");
  });
});
