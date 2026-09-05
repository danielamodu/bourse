import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  BOURSE_FEE_BPS,
  KYBERSWAP_ROUTER_ADDRESS,
  MAX_QUOTE_USDC_UNITS,
  MIN_QUOTE_USDC_UNITS,
  QUOTE_TTL_MS,
  ROUTER_ABSENT_DETAIL,
  ROUTER_MISMATCH_DETAIL,
  bourseFeeParams,
  executionCostBps,
  isQuoteExpired,
  ngnToUsdcUnits,
  parseQuoteParams,
  parseQuoteWire,
  quoteMsRemaining,
  requestQuote,
  toQuoteWire,
  type QuoteResult,
} from "@/lib/quote";
import { CHAINLINK_FEEDS, TOKEN_ADDRESSES, USDC_ADDRESS } from "@/lib/tokens";

/**
 * Offline throughout. Every test hands `requestQuote` a stub `fetchImpl`, so the
 * suite never reaches KyberSwap and never depends on a route existing today.
 *
 * The wire shape these fixtures imitate is the thing that cannot be proven here —
 * it comes from KyberSwap's docs and a hand-read response, not from a contract.
 * `verify/quote.verify.ts` is what checks it against the live API.
 */

const NVDA = TOKEN_ADDRESSES.NVDA;

/** $30, the reference ticket. 8 token decimals, so 5_000_000 units = 0.05 shares. */
const USDC_IN = 30_000_000n;
const UNITS_OUT = "5000000";
const NOW = 1_757_000_000_000;

/**
 * The pinned router, not a fixture value.
 *
 * Deliberately the constant rather than a literal copied beside it. A fixture that
 * spelled the address out would keep passing after the pin changed, which is the
 * one thing these tests exist to catch: the router is the spender of a USDC
 * allowance in Part B, so a test suite that goes green against a stale pin is worse
 * than no suite.
 */
const ROUTER = KYBERSWAP_ROUTER_ADDRESS;

type SummaryOverrides = Record<string, unknown>;

/** A successful `routeSummary`, with any field replaceable or removable. */
function summary(overrides: SummaryOverrides = {}): Record<string, unknown> {
  return {
    tokenIn: USDC_ADDRESS,
    amountIn: USDC_IN.toString(),
    amountInUsd: "30",
    tokenOut: NVDA,
    amountOut: UNITS_OUT,
    amountOutUsd: "29.94",
    gas: "220000",
    gasPrice: "10000000",
    gasUsd: "0.004",
    routerAddress: ROUTER,
    ...overrides,
  };
}

type Call = { url: URL; init: RequestInit | undefined };

/** A `fetch` that never leaves the process, plus the calls it recorded. */
function stub(handler: (url: URL) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A 200 carrying a route. `undefined` in an override removes that field. */
function routed(
  overrides: SummaryOverrides = {},
  data: Record<string, unknown> = {},
): Response {
  return json({
    code: 0,
    message: "successfully",
    data: { routeSummary: summary(overrides), ...data },
  });
}

/** Narrows, and puts the aggregator's own reason in the failure message. */
function expectQuote(result: QuoteResult) {
  if (result.kind !== "quote") {
    throw new Error(`expected a quote, got ${result.kind}: ${result.detail}`);
  }
  return result.quote;
}

async function quoteFor(
  response: (url: URL) => Response | Promise<Response>,
  usdcIn = USDC_IN,
): Promise<QuoteResult> {
  const { fetchImpl } = stub(response);
  return requestQuote("NVDA", usdcIn, { fetchImpl, nowMs: NOW });
}

function onlyCall(calls: Call[]): Call {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) throw new Error("no request was made");
  return call;
}

describe("requestQuote: the request", () => {
  it("asks the Base routes endpoint for USDC in and the stock token out", async () => {
    const { fetchImpl, calls } = stub(() => routed());
    await requestQuote("NVDA", USDC_IN, { fetchImpl, nowMs: NOW });

    const { url } = onlyCall(calls);

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://aggregator-api.kyberswap.com/base/api/v1/routes",
    );
    expect(url.searchParams.get("tokenIn")).toBe(USDC_ADDRESS);
    expect(url.searchParams.get("tokenOut")).toBe(NVDA);
    expect(url.searchParams.get("amountIn")).toBe("30000000");
    // Without this the response carries no gas estimate, and the panel is
    // required to show one.
    expect(url.searchParams.get("gasInclude")).toBe("true");
  });

  it("sends the client id and asks for JSON", async () => {
    const { fetchImpl, calls } = stub(() => routed());
    await requestQuote("NVDA", USDC_IN, { fetchImpl, nowMs: NOW });

    const headers = onlyCall(calls).init?.headers as
      | Record<string, string>
      | undefined;

    expect(headers?.["accept"]).toBe("application/json");
    // Asserted as present, not as a value: it is read from the environment.
    expect(headers?.["x-client-id"]).toBeTruthy();
  });

  it("rejects a non-positive amount without spending a round trip", async () => {
    const { fetchImpl, calls } = stub(() => routed());
    const result = await requestQuote("NVDA", 0n, { fetchImpl, nowMs: NOW });

    expect(result.kind).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

describe("requestQuote: a priced route", () => {
  it("reads the summary into a quote", async () => {
    const quote = expectQuote(await quoteFor(() => routed()));

    expect(quote.symbol).toBe("NVDA");
    expect(quote.usdcIn).toBe(30_000_000n);
    expect(quote.usdIn).toBe(30);
    expect(quote.unitsOut).toBe(5_000_000n);
    // 8 token decimals — the number verify:chain read off the contract. At 18
    // this would come out as 5e-12 of a share, which is the failure mode the
    // registry comment exists to prevent.
    expect(quote.shares).toBe(0.05);
    expect(quote.usdPerShare).toBeCloseTo(600, 9);
    expect(quote.gasUsd).toBe(0.004);
    expect(quote.routerAddress).toBe(ROUTER);
  });

  it("stamps expiry one TTL after the injected clock", async () => {
    const quote = expectQuote(await quoteFor(() => routed()));

    expect(quote.receivedAtMs).toBe(NOW);
    expect(quote.expiresAtMs).toBe(NOW + QUOTE_TTL_MS);
    expect(QUOTE_TTL_MS).toBe(30_000);
  });

  it("derives the execution cost from the two USD legs", async () => {
    // $30 in, $29.94 out — 6 cents of 30 dollars, 20bps.
    const quote = expectQuote(await quoteFor(() => routed()));
    expect(quote.executionCostBps).toBe(20);
  });

  it("leaves the cost null when the aggregator priced only one leg", async () => {
    const quote = expectQuote(
      await quoteFor(() => routed({ amountOutUsd: undefined })),
    );

    // Null, never zero: an unpriced leg is not a free trade, and only a real
    // number should let a buy affordance render.
    expect(quote.executionCostBps).toBeNull();
  });

  it("clamps a negative cost to zero rather than showing a gain", async () => {
    const quote = expectQuote(
      await quoteFor(() => routed({ amountOutUsd: "30.15" })),
    );

    expect(quote.executionCostBps).toBe(0);
  });

  it("reports gas as null when the response carries none", async () => {
    const quote = expectQuote(
      await quoteFor(() => routed({ gasUsd: undefined })),
    );

    expect(quote.gasUsd).toBeNull();
  });

  it("multiplies the gas legs into wei", async () => {
    // 220,000 units at 0.01 gwei. Wei rather than dollars because the figure is
    // compared against an ETH balance, and no ETH price is available to do that in
    // USD -- see the low-ETH warning in `lib/wallet-state.ts`.
    const quote = expectQuote(await quoteFor(() => routed()));

    expect(quote.gasWei).toBe(2_200_000_000_000n);
  });

  it("leaves gas in wei null when either leg is missing", async () => {
    for (const missing of ["gas", "gasPrice"]) {
      const quote = expectQuote(
        await quoteFor(() => routed({ [missing]: undefined })),
      );

      // Null and not zero. Zero wei would read as a free transaction and switch
      // off the very warning this figure exists to raise.
      expect(quote.gasWei, `without ${missing}`).toBeNull();
    }
  });

  it("leaves gas in wei null when a leg is zero or unreadable", async () => {
    for (const gasPrice of ["0", "-1", "1.5", "0x10", "", "lots"]) {
      const quote = expectQuote(await quoteFor(() => routed({ gasPrice })));

      expect(quote.gasWei, `gasPrice ${gasPrice}`).toBeNull();
    }
  });

  it("falls back to the envelope's routerAddress", async () => {
    const quote = expectQuote(
      await quoteFor(() =>
        routed({ routerAddress: undefined }, { routerAddress: ROUTER }),
      ),
    );

    expect(quote.routerAddress).toBe(ROUTER);
  });

  it("accepts an echo in different checksum casing", async () => {
    // EIP-55 casing is cosmetic and the aggregator owes us nothing here, so
    // comparing the strings as sent would reject valid responses.
    const quote = expectQuote(
      await quoteFor(() =>
        routed({
          tokenOut: NVDA.toLowerCase(),
          tokenIn: USDC_ADDRESS.toUpperCase().replace("0X", "0x"),
        }),
      ),
    );

    expect(quote.symbol).toBe("NVDA");
  });

  it("tolerates a response that does not echo amountIn", async () => {
    // Only a *contradicting* echo is disqualifying. A missing one leaves the
    // amount we sent as the only claim about the amount, which it already was.
    const quote = expectQuote(
      await quoteFor(() => routed({ amountIn: undefined })),
    );

    expect(quote.usdcIn).toBe(USDC_IN);
  });
});

/**
 * "This cannot be bought" — a fact about the market, so it is only ever returned
 * when the aggregator actually answered.
 */
describe("requestQuote: no liquidity", () => {
  it("reads a 404 as the market, not the request", async () => {
    const result = await quoteFor(() => new Response("", { status: 404 }));
    expect(result.kind).toBe("no-liquidity");
  });

  it("reads a recognised no-route message as the market", async () => {
    const result = await quoteFor(() =>
      json({ code: 4005, message: "route not found", data: {} }),
    );

    expect(result.kind).toBe("no-liquidity");
  });

  it("reads a missing routeSummary plus a no-route message as the market", async () => {
    const result = await quoteFor(() =>
      json({ code: 0, message: "insufficient liquidity", data: {} }),
    );

    expect(result.kind).toBe("no-liquidity");
  });

  it("reads a route that returns nothing as the market", async () => {
    const result = await quoteFor(() => routed({ amountOut: "0" }));
    expect(result.kind).toBe("no-liquidity");
  });
});

/**
 * "We could not get a price" — everything we do not understand lands here,
 * because it is the reversible message. Claiming a stock has no market on the
 * strength of an unfamiliar error string would be a lie told with confidence.
 */
describe("requestQuote: failures", () => {
  it("does not throw when fetch throws", async () => {
    const result = await quoteFor(() => {
      throw new Error("network unreachable");
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.detail).toContain("network unreachable");
    }
  });

  it("fails on a 500", async () => {
    const result = await quoteFor(() => new Response("", { status: 500 }));

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.detail).toContain("500");
  });

  it("fails on a body that is not JSON", async () => {
    const result = await quoteFor(
      () => new Response("<html>rate limited</html>", { status: 200 }),
    );

    expect(result.kind).toBe("failed");
  });

  it("fails on a body that is not an object", async () => {
    const result = await quoteFor(() => json(null));
    expect(result.kind).toBe("failed");
  });

  it("fails rather than guessing on an unrecognised error", async () => {
    const result = await quoteFor(() =>
      json({ code: 4009, message: "client id quota exceeded", data: {} }),
    );

    // A quota problem is ours. Rendering it as "this stock cannot be bought"
    // would be a false statement about the market.
    expect(result.kind).toBe("failed");
  });
});

/**
 * The echo guards.
 *
 * The address we send is shape-checked before it goes out, so what is left to
 * check is that the answer is about the address we sent. A response describing
 * some other pair is not this token's price, however well-formed it looks.
 */
describe("requestQuote: echo guards", () => {
  it("refuses a summary priced for a different token", async () => {
    const result = await quoteFor(() =>
      routed({ tokenOut: TOKEN_ADDRESSES.GOOGL }),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.detail).toContain("tokenOut");
    }
  });

  it("refuses a summary priced for a lookalike address", async () => {
    const result = await quoteFor(() =>
      routed({ tokenOut: "0xb2A4c1De9f3B8e07C25d6a4F19b3E8c05D72a1B6" }),
    );

    expect(result.kind).toBe("failed");
  });

  it("refuses a summary that spent something other than USDC", async () => {
    const result = await quoteFor(() =>
      routed({ tokenIn: CHAINLINK_FEEDS.NVDA }),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.detail).toContain("tokenIn");
  });

  it("refuses a summary that priced a different amount", async () => {
    const result = await quoteFor(() => routed({ amountIn: "31000000" }));

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.detail).toContain("amountIn");
  });

  it("refuses an amountOut it cannot read exactly", async () => {
    // Floats and scientific notation are not token amounts. Accepting one would
    // put a rounded number where an exact unit count belongs.
    for (const amountOut of ["5.0e6", "1.5", "abc", "-5000000", "0x4c4b40"]) {
      const result = await quoteFor(() => routed({ amountOut }));
      expect(result.kind, amountOut).toBe("failed");
    }
  });
});

/**
 * The router pin, checked at both boundaries it crosses.
 *
 * This is the guard with the most at stake in the file. In Part B the router is the
 * spender of a user's USDC allowance, so a response that could name its own router
 * could name a contract of its own and receive an allowance over every USDC the
 * wallet will ever hold. Unlike a bad price, that is invisible after the fact and
 * survives the session. So a response that names anything but the pin — or names
 * nothing — is `failed`, and no quote reaches the panel from it.
 */
describe("the router pin", () => {
  it("pins a checksummed address, not a shape", () => {
    // Asserted here so the constant cannot be edited to something ill-formed
    // without a test going red. Its authenticity comes from `verify:chain` proving
    // it has bytecode and `verify:quote` seeing the live API name it — never from
    // this file.
    //
    // The pattern accepts either case. Checksum casing is cosmetic on the wire and
    // the constant carries it, so a lowercase-only pattern would reject the pin
    // itself; it did, which is why this reads `a-fA-F`.
    expect(KYBERSWAP_ROUTER_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // Forty hex characters is a shape. EIP-55 casing is the only transcription
    // check an address carries: the pattern of upper and lower case is derived from
    // the address's own keccak hash, so a single wrong character re-randomises it
    // and fails — EIP-55 puts the residual chance of a mistyped address passing at
    // 0.0247%. That is exactly the failure that put a dead address in this
    // constant, and it is the failure a shape check cannot see.
    //
    // `getAddress` re-derives the casing rather than validating it, so equality is
    // the assertion: it holds only when the constant is already canonical, and a
    // failure prints both strings. Never lowercase the constant to make this pass —
    // that removes the check instead of satisfying it.
    expect(getAddress(KYBERSWAP_ROUTER_ADDRESS)).toBe(KYBERSWAP_ROUTER_ADDRESS);
  });

  it("refuses a route through any other router", async () => {
    const attacker = "0xdead000000000000000000000000000000000beef";
    const result = await quoteFor(() => routed({ routerAddress: attacker }));

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.detail).toContain(ROUTER_MISMATCH_DETAIL);
      // The address it tried to name goes in the log line, so the case is
      // diagnosable from a server log rather than only reproducible.
      expect(result.detail).toContain(attacker);
    }
  });

  it("refuses a route that names no router at all", async () => {
    // Fails closed, deliberately, and the cost is real: if KyberSwap ever drops the
    // field every quote fails until we notice. `verify:quote` is what surfaces that
    // — instead of a user's allowance doing it.
    const result = await quoteFor(() => routed({ routerAddress: undefined }));

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.detail).toContain(ROUTER_ABSENT_DETAIL);
    }
  });

  it("refuses a router that is not a string", async () => {
    for (const routerAddress of [null, 7, {}, [ROUTER]]) {
      const result = await quoteFor(() => routed({ routerAddress }));
      expect(result.kind, JSON.stringify(routerAddress)).toBe("failed");
    }
  });

  it("accepts the pin in any casing", async () => {
    // EIP-55 casing is cosmetic and KyberSwap returns this one lowercase, so
    // comparing as given would reject every real response the day they checksum it.
    const quote = expectQuote(
      await quoteFor(() =>
        routed({ routerAddress: ROUTER.toUpperCase().replace("0X", "0x") }),
      ),
    );

    expect(quote.routerAddress.toLowerCase()).toBe(ROUTER.toLowerCase());
  });

  it("re-checks the pin on the way back into the browser", async () => {
    // The payload takes a second network hop from our own route, and this is the
    // last boundary before a `Quote` exists in the browser — the object Part B
    // reads a spender out of.
    const fields = await wireFields();

    const swapped = parseQuoteWire({
      ...fields,
      routerAddress: "0xdead000000000000000000000000000000000beef",
    });
    expect(swapped.kind).toBe("failed");
    if (swapped.kind === "failed") {
      expect(swapped.detail).toBe(ROUTER_MISMATCH_DETAIL);
    }

    const absent = parseQuoteWire(without(fields, "routerAddress"));
    expect(absent.kind).toBe("failed");
    if (absent.kind === "failed") {
      expect(absent.detail).toBe(ROUTER_ABSENT_DETAIL);
    }

    const recased = parseQuoteWire({
      ...fields,
      routerAddress: ROUTER.toUpperCase().replace("0X", "0x"),
    });
    expect(recased.kind).toBe("quote");
  });
});

describe("executionCostBps", () => {
  it("measures the gap between the two USD legs", () => {
    expect(executionCostBps(30, 29.94)).toBe(20);
    expect(executionCostBps(30, 27)).toBe(1_000);
  });

  it("states a whole number of basis points as that whole number", () => {
    // Floating point can miss a whole basis point in either direction and `ceilBps`
    // has to stay honest both ways. `(30 - 29.94) / 30 * 10_000` above comes out at
    // 19.999999999999574, which the ceiling lifts back to 20; this one comes out at
    // 10.000000000000379, and without `BPS_EPSILON` a route costing exactly 10bps
    // would be charged as 11.
    expect(executionCostBps(30, 29.97)).toBe(10);
  });

  it("is zero when the legs agree", () => {
    expect(executionCostBps(30, 30)).toBe(0);
  });

  it("clamps a favourable disagreement to zero", () => {
    // Two independent price lookups disagreeing is not a gain to display.
    expect(executionCostBps(30, 30.15)).toBe(0);
  });

  it("is null when either leg is missing or unusable", () => {
    expect(executionCostBps(null, 30)).toBeNull();
    expect(executionCostBps(30, null)).toBeNull();
    expect(executionCostBps(Number.NaN, 30)).toBeNull();
    expect(executionCostBps(30, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("is null rather than infinite when nothing went in", () => {
    expect(executionCostBps(0, 0)).toBeNull();
    expect(executionCostBps(-5, 1)).toBeNull();
  });

  it("rounds a cost up to the next whole basis point", () => {
    // The rounding contract, from `ceilBps` in lib/price.ts: toward positive
    // infinity, never to nearest, so a figure can only overstate what the trade
    // costs. Half a basis point of cost is 1bp here; `Math.round` made it 0,
    // which reads as a free route. A tenth of one likewise.
    expect(executionCostBps(100, 99.995)).toBe(1);
    expect(executionCostBps(100, 99.999)).toBe(1);

    // $30 valued at $20 is 3,333⅓bps, so the figure shown is 3,334.
    expect(executionCostBps(30, 20)).toBe(3_334);
  });

  it("lands in the measured 58 to 105bps band on real figures", () => {
    // The band the four live routes measured at a ₦50,000 ticket. The legs here are
    // constructed to hit its ends rather than transcribed from a response, and the
    // point is the range: a cost in this band is a market spread, and the formatter's
    // "under 0.01%" branch is unreachable for anything in it.
    expect(executionCostBps(30, 29.826)).toBe(58);
    expect(executionCostBps(30, 29.685)).toBe(105);
  });
});

describe("quote expiry", () => {
  it("counts down from the TTL and stops at zero", async () => {
    const quote = expectQuote(await quoteFor(() => routed()));

    expect(quoteMsRemaining(quote, NOW)).toBe(QUOTE_TTL_MS);
    expect(quoteMsRemaining(quote, NOW + 10_000)).toBe(20_000);
    expect(quoteMsRemaining(quote, NOW + 60_000)).toBe(0);
  });

  it("treats the expiry instant itself as expired", async () => {
    const quote = expectQuote(await quoteFor(() => routed()));

    expect(isQuoteExpired(quote, NOW)).toBe(false);
    expect(isQuoteExpired(quote, NOW + QUOTE_TTL_MS - 1)).toBe(false);
    expect(isQuoteExpired(quote, NOW + QUOTE_TTL_MS)).toBe(true);
  });
});

describe("ngnToUsdcUnits", () => {
  it("converts a real ticket at a real rate", () => {
    // ₦50,000 at ₦1,650/$ is $30.30, the reference order.
    expect(ngnToUsdcUnits(50_000, 1_650)).toBe(30_303_030n);
    expect(ngnToUsdcUnits(3, 2)).toBe(1_500_000n);
  });

  it("rounds down, never up", () => {
    // Overstating what we send would quote a trade the user cannot fund.
    expect(ngnToUsdcUnits(1, 3)).toBe(333_333n);
  });

  it("is null for an amount too small to be worth a unit", () => {
    expect(ngnToUsdcUnits(0.0001, 1_650)).toBeNull();
  });

  it("is null without a usable rate", () => {
    expect(ngnToUsdcUnits(50_000, null)).toBeNull();
    expect(ngnToUsdcUnits(50_000, 0)).toBeNull();
    expect(ngnToUsdcUnits(50_000, -1_650)).toBeNull();
    expect(ngnToUsdcUnits(50_000, Number.NaN)).toBeNull();
  });

  it("is null for an amount that is not a positive number", () => {
    expect(ngnToUsdcUnits(0, 1_650)).toBeNull();
    expect(ngnToUsdcUnits(-50_000, 1_650)).toBeNull();
    expect(ngnToUsdcUnits(Number.NaN, 1_650)).toBeNull();
    expect(ngnToUsdcUnits(Number.POSITIVE_INFINITY, 1_650)).toBeNull();
  });
});

describe("the order-size band", () => {
  it("is $1 to $1,000,000 in USDC base units", () => {
    // Shared with the hook so it can say "too small" before spending a request.
    expect(MIN_QUOTE_USDC_UNITS).toBe(1_000_000n);
    expect(MAX_QUOTE_USDC_UNITS).toBe(1_000_000_000_000n);
    expect(MIN_QUOTE_USDC_UNITS < MAX_QUOTE_USDC_UNITS).toBe(true);
  });

  it("contains the reference ₦50,000 ticket", () => {
    const units = ngnToUsdcUnits(50_000, 1_650);
    expect(units).not.toBeNull();
    if (units === null) return;

    expect(units >= MIN_QUOTE_USDC_UNITS).toBe(true);
    expect(units <= MAX_QUOTE_USDC_UNITS).toBe(true);
  });
});

/**
 * `/api/quote` is unauthenticated and forwards to a third party under our client
 * id, so both parameters are bounded here rather than trusted and passed on. Every
 * rejection is a 400 the route hands back verbatim.
 */
describe("parseQuoteParams", () => {
  function parse(query: string) {
    return parseQuoteParams(new URLSearchParams(query));
  }

  it("accepts a real ticket", () => {
    // ₦50,000 at ₦1,650/$.
    const result = parse("symbol=NVDA&amountIn=30303030");

    expect(result).toEqual({ ok: true, symbol: "NVDA", usdcIn: 30_303_030n });
  });

  it("rejects a symbol that is not one of the thirteen", () => {
    for (const query of [
      "amountIn=30000000",
      "symbol=&amountIn=30000000",
      "symbol=ZZZZ&amountIn=30000000",
      "symbol=nvda&amountIn=30000000",
      "symbol=constructor&amountIn=30000000",
    ]) {
      expect(parse(query).ok, query).toBe(false);
    }
  });

  it("rejects a listed stock we hold no address for, by name", () => {
    // "TSLA is not quotable" and "ZZZZ is not a stock" are different mistakes, and
    // the first one is worth saying plainly — the token is real, the pool is not.
    const result = parse("symbol=TSLA&amountIn=30000000");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("TSLA");
  });

  it("rejects anything that is not an integer number of base units", () => {
    for (const amountIn of [
      "",
      "-30000000",
      "1.5",
      "1e7",
      "+30000000",
      " 30000000",
      "0x1c9c380",
      "abc",
      "30_000_000",
      "Infinity",
    ]) {
      const result = parse(`symbol=NVDA&amountIn=${encodeURIComponent(amountIn)}`);
      expect(result.ok, amountIn).toBe(false);
      if (!result.ok) expect(result.reason, amountIn).toContain("integer");
    }
  });

  it("rejects a missing amountIn", () => {
    expect(parse("symbol=NVDA").ok).toBe(false);
  });

  it("rejects an over-long digit run before converting it", () => {
    // The cheap check goes first on purpose: `BigInt()` conversion cost grows faster
    // than its input, so a multi-kilobyte run of digits must be refused on length
    // rather than parsed and then found to be outside the band.
    const result = parse(`symbol=NVDA&amountIn=${"9".repeat(25)}`);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("integer");
  });

  it("rejects amounts outside the band, including zero", () => {
    for (const amountIn of [
      "0",
      "999999",
      (MAX_QUOTE_USDC_UNITS + 1n).toString(),
    ]) {
      const result = parse(`symbol=NVDA&amountIn=${amountIn}`);
      expect(result.ok, amountIn).toBe(false);
      if (!result.ok) expect(result.reason, amountIn).toContain("between");
    }
  });

  it("accepts both ends of the band", () => {
    for (const units of [MIN_QUOTE_USDC_UNITS, MAX_QUOTE_USDC_UNITS]) {
      const result = parse(`symbol=NVDA&amountIn=${units}`);
      expect(result.ok, units.toString()).toBe(true);
    }
  });
});

/**
 * Bourse's fee, at zero and above it.
 *
 * Both branches are covered offline because the shape of a request Bourse has never
 * sent in anger is exactly the thing that should be pinned by a test rather than
 * discovered on the day someone switches a fee on.
 */
describe("bourseFeeParams", () => {
  it("charges nothing today", () => {
    expect(BOURSE_FEE_BPS).toBe(0);
  });

  it("attaches nothing at zero, even with a receiver configured", () => {
    // Omitted entirely rather than sent as `feeAmount=0`. A fee of zero is not a
    // fee, and sending it invites the aggregator to reject the request or to quote
    // one with a fee routed nowhere.
    expect(bourseFeeParams(0, "0x0000000000000000000000000000000000000001")).toEqual({
      kind: "none",
    });
    expect(bourseFeeParams(0, null)).toEqual({ kind: "none" });
    expect(bourseFeeParams(-25, "0x0000000000000000000000000000000000000001")).toEqual(
      { kind: "none" },
    );
    expect(bourseFeeParams(Number.NaN, null)).toEqual({ kind: "none" });
  });

  it("builds KyberSwap's parameters when a fee is set", () => {
    const receiver = "0x0000000000000000000000000000000000000001";
    const result = bourseFeeParams(25, receiver);

    expect(result).toEqual({
      kind: "params",
      params: {
        feeAmount: "25",
        isInBps: "true",
        // Taken from the USDC going in, so the fee sits inside the amount the user
        // already agreed to pay instead of quietly reducing the share count they
        // were shown. That is what lets the panel state one total.
        chargeFeeBy: "currency_in",
        feeReceiver: receiver,
      },
    });
  });

  it("refuses a fee with nowhere to send it", () => {
    const result = bourseFeeParams(25, null);

    expect(result.kind).toBe("misconfigured");
    if (result.kind === "misconfigured") {
      expect(result.detail).toContain("BOURSE_FEE_RECEIVER");
    }
  });

  it("refuses a fractional basis point", () => {
    const result = bourseFeeParams(12.5, "0x0000000000000000000000000000000000000001");

    expect(result.kind).toBe("misconfigured");
    if (result.kind === "misconfigured") {
      expect(result.detail).toContain("whole number");
    }
  });
});

describe("the live request at BOURSE_FEE_BPS = 0", () => {
  it("sends no fee parameters", async () => {
    const { fetchImpl, calls } = stub(() => routed());
    await requestQuote("NVDA", USDC_IN, { fetchImpl, nowMs: NOW });

    const { url } = onlyCall(calls);

    for (const key of ["feeAmount", "isInBps", "chargeFeeBy", "feeReceiver"]) {
      expect(url.searchParams.has(key), key).toBe(false);
    }
  });
});

/** A quote as `/api/quote` sends it and the hook reads it back. */
async function wireFields(): Promise<Record<string, unknown>> {
  const wire = toQuoteWire(await quoteFor(() => routed()));
  return { ...wire };
}

function without(
  fields: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...fields };
  delete copy[key];
  return copy;
}

describe("the browser seam", () => {
  it("survives a JSON round trip with both amounts exact", async () => {
    const result = await quoteFor(() => routed());
    const wire = toQuoteWire(result);

    if (wire.kind !== "quote") {
      throw new Error(`expected a quote wire, got ${wire.kind}`);
    }

    // bigint does not serialise, and these two are exact values Part B will sign
    // over, so they cross as decimal strings rather than being rounded into
    // numbers on the way.
    expect(wire.usdcIn).toBe("30000000");
    expect(wire.unitsOut).toBe("5000000");
    // A third exact value, for the same reason. Wei is well past what a float can
    // hold at a realistic gas price, so it crosses as a string too.
    expect(wire.gasWei).toBe("2200000000000");

    const back = parseQuoteWire(JSON.parse(JSON.stringify(wire)) as unknown);
    expect(back).toEqual(result);
  });

  it("sends the two non-quote cases without their reason", () => {
    // `detail` is for the server log. It can carry upstream text, and what the
    // user reads is our own copy chosen from the three cases.
    expect(
      toQuoteWire({ kind: "no-liquidity", detail: "aggregator returned 404" }),
    ).toEqual({ kind: "no-liquidity" });

    expect(toQuoteWire({ kind: "failed", detail: "HTTP 500" })).toEqual({
      kind: "failed",
    });
  });

  it("reads the two non-quote cases back", () => {
    expect(parseQuoteWire({ kind: "no-liquidity" }).kind).toBe("no-liquidity");
    expect(parseQuoteWire({ kind: "failed" }).kind).toBe("failed");
  });
});

/**
 * The payload arrives over a network, so it is parsed rather than cast. A
 * truncated or rewritten response has to read as `failed` — which the browser can
 * retry — and never reach the panel as a number that renders as `NaN` shares.
 */
describe("parseQuoteWire: rejections", () => {
  it("rejects anything that is not a quote payload", () => {
    for (const value of [null, undefined, "quote", 7, [], {}]) {
      expect(parseQuoteWire(value).kind, String(value)).toBe("failed");
    }
  });

  it("rejects a payload missing an amount", async () => {
    const fields = await wireFields();

    for (const key of ["usdcIn", "unitsOut", "usdIn", "shares", "usdPerShare"]) {
      expect(parseQuoteWire(without(fields, key)).kind, key).toBe("failed");
    }
  });

  it("rejects a payload missing its timestamps", async () => {
    const fields = await wireFields();

    for (const key of ["receivedAtMs", "expiresAtMs"]) {
      expect(parseQuoteWire(without(fields, key)).kind, key).toBe("failed");
    }
  });

  it("rejects a symbol we hold no address for", async () => {
    // TSLA is issued and has a working feed, and no published address — so a
    // quote naming it did not come from us.
    const result = parseQuoteWire({ ...(await wireFields()), symbol: "TSLA" });
    expect(result.kind).toBe("failed");
  });

  it("rejects amounts that are not exact integers", async () => {
    const fields = await wireFields();

    expect(parseQuoteWire({ ...fields, unitsOut: "5.5" }).kind).toBe("failed");
    expect(parseQuoteWire({ ...fields, usdcIn: "3e7" }).kind).toBe("failed");
  });

  it("rejects a payload that would render as zero shares", async () => {
    const fields = await wireFields();

    expect(parseQuoteWire({ ...fields, shares: 0 }).kind).toBe("failed");
    expect(parseQuoteWire({ ...fields, usdIn: 0 }).kind).toBe("failed");
  });
});
