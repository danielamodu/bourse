import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  MAX_SELL_TOKEN_UNITS,
  MIN_SELL_TOKEN_UNITS,
  buildSellSwap,
  isSellNoRoute,
  isSellPriceMoved,
  parseSellBuildBody,
  parseSellQuoteParams,
  parseSellQuoteWire,
  parseSellSwapWire,
  prepareSellSwap,
  requestSellQuote,
  requestSellRoute,
  toSellQuoteWire,
  toSellSwapWire,
  withSellNgnQuote,
  type SellQuote,
} from "@/lib/sell";
import {
  KYBERSWAP_ROUTER_ADDRESS,
  QUOTE_TTL_MS,
} from "@/lib/quote";
import { TOKEN_ADDRESSES, USDC_ADDRESS } from "@/lib/tokens";

/**
 * The sell path, pinned offline.
 *
 * Same arrangement as `lib/quote.test.ts` and `lib/build.test.ts`: every
 * test hands the module a stub `fetchImpl`, so nothing here reaches the
 * network and the suite stays deterministic. What is pinned is the guards —
 * the echoes, the pin, the derived floor — against fixtures, which proves
 * the logic and says nothing about whether the fixtures still resemble the
 * API. That half is `verify/sell-quote.verify.ts` and
 * `verify/sell-simulate.verify.ts`.
 */

const NOW = 1_750_000_000_000;

/** 0.01 shares at 8 decimals — the probe size the live checks use. */
const TOKEN_IN = 1_000_000n;

/** A placeholder sender assembled from one repeated byte, not transcribed. */
const SENDER = getAddress(`0x${"cd".repeat(20)}`);

type Stub = {
  fetchImpl: typeof fetch;
  calls: unknown[][];
};

function stub(handler: () => Response): Stub {
  const calls: unknown[][] = [];
  const fetchImpl = ((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(handler());
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A priced NVDA→USDC route, as the mapping needs it. */
function routed(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    message: "success",
    data: {
      routeSummary: {
        tokenIn: TOKEN_ADDRESSES.NVDA,
        amountIn: TOKEN_IN.toString(),
        amountInUsd: "2.00",
        tokenOut: USDC_ADDRESS,
        amountOut: "2000000",
        amountOutUsd: "2.00",
        gas: "220000",
        gasPrice: "10000000",
        gasUsd: "0.03",
        routerAddress: KYBERSWAP_ROUTER_ADDRESS,
        ...overrides,
      },
      routerAddress: KYBERSWAP_ROUTER_ADDRESS,
    },
  };
}

async function sellFor(
  summary: () => Response,
  tokenIn: bigint = TOKEN_IN,
) {
  const { fetchImpl } = stub(summary);
  return requestSellQuote("NVDA", tokenIn, { fetchImpl, nowMs: NOW });
}

function built(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    message: "success",
    data: {
      amountIn: TOKEN_IN.toString(),
      amountOut: "2000000",
      gas: "220000",
      data: "0xabcdef",
      routerAddress: KYBERSWAP_ROUTER_ADDRESS,
      transactionValue: "0",
      ...overrides,
    },
  };
}

async function sellQuote(): Promise<SellQuote> {
  const result = await sellFor(() => json(routed()));
  if (result.kind !== "quote") throw new Error("fixture did not quote");
  return result.quote;
}

describe("parseSellQuoteParams", () => {
  const params = (symbol: string, amountIn: string) => {
    const query = new URLSearchParams({ symbol, amountIn });
    return parseSellQuoteParams(query);
  };

  it("accepts a quotable symbol and an in-band amount", () => {
    expect(params("NVDA", TOKEN_IN.toString())).toEqual({
      ok: true,
      symbol: "NVDA",
      tokenIn: TOKEN_IN,
    });
  });

  it("rejects what is not a stock, and what is a stock without an address", () => {
    expect(params("ZZZZ", "1000000")).toEqual({
      ok: false,
      reason: "symbol must be one of the listed stocks",
    });
    // COIN is issued but unpublished: nothing to quote against.
    expect(params("COIN", "1000000")).toEqual({
      ok: false,
      reason: "COIN has no token address on Base, so it cannot be sold",
    });
  });

  it("rejects malformed and out-of-band amounts", () => {
    for (const amountIn of ["", "-5", "1.5", "1e6", "x".repeat(25)]) {
      const parsed = params("NVDA", amountIn);
      expect(parsed.ok, amountIn).toBe(false);
    }

    expect(params("NVDA", "0")).toMatchObject({ ok: false });
    expect(params("NVDA", (MIN_SELL_TOKEN_UNITS - 1n).toString())).toMatchObject({
      ok: false,
    });
    expect(params("NVDA", (MAX_SELL_TOKEN_UNITS + 1n).toString())).toMatchObject({
      ok: false,
    });
    expect(params("NVDA", MIN_SELL_TOKEN_UNITS.toString())).toMatchObject({
      ok: true,
    });
  });
});

describe("requestSellQuote", () => {
  it("quotes stock in and USDC out, with the echoes checked", async () => {
    const result = await sellFor(() => json(routed()));
    expect(result.kind).toBe("quote");
    if (result.kind !== "quote") return;

    const { quote } = result;
    expect(quote.symbol).toBe("NVDA");
    expect(quote.tokenIn).toBe(TOKEN_IN);
    expect(quote.sharesIn).toBeCloseTo(0.01, 10);
    expect(quote.usdcOut).toBe(2_000_000n);
    expect(quote.usdOut).toBeCloseTo(2, 10);
    expect(quote.usdPerShare).toBeCloseTo(200, 8);
    expect(quote.expiresAtMs - quote.receivedAtMs).toBe(QUOTE_TTL_MS);
    expect(quote.routerAddress.toLowerCase()).toBe(
      KYBERSWAP_ROUTER_ADDRESS.toLowerCase(),
    );
  });

  it("asks about the stock, not USDC", async () => {
    const { fetchImpl, calls } = stub(() => json(routed()));
    await requestSellQuote("NVDA", TOKEN_IN, { fetchImpl, nowMs: NOW });

    const url = String(calls[0]?.[0]);
    expect(url).toContain(`tokenIn=${encodeURIComponent(TOKEN_ADDRESSES.NVDA)}`);
    expect(url).toContain(`tokenOut=${encodeURIComponent(USDC_ADDRESS)}`);
    expect(url).toContain(`amountIn=${TOKEN_IN}`);
  });

  it("fails closed on a wrong echo or a moved router", async () => {
    for (const summary of [
      routed({ tokenIn: USDC_ADDRESS }),
      routed({ tokenOut: TOKEN_ADDRESSES.NVDA }),
      routed({ amountIn: "999999" }),
      routed({ routerAddress: SENDER }),
    ]) {
      const result = await sellFor(() => json(summary));
      expect(result.kind, JSON.stringify(summary)).toBe("failed");
    }
  });

  it("reads an empty route as the market, not as a fault", async () => {
    expect(await sellFor(() => json(routed({ amountOut: "0" })))).toMatchObject(
      { kind: "no-liquidity" },
    );
    expect(await sellFor(() => new Response("", { status: 404 }))).toMatchObject(
      { kind: "no-liquidity" },
    );
    expect(
      await sellFor(() =>
        json({ code: 106, message: "No route found for this pair" }),
      ),
    ).toMatchObject({ kind: "no-liquidity" });
  });

  it("fails rather than claims on transport and garbage", async () => {
    expect(await sellFor(() => new Response("", { status: 500 }))).toMatchObject(
      { kind: "failed" },
    );
    expect(
      await sellFor(() => new Response("<html>gateway</html>", { status: 200 })),
    ).toMatchObject({ kind: "failed" });
    expect(await sellFor(() => json({ code: 400, message: "bad app id" }))).toMatchObject(
      { kind: "failed" },
    );
  });

  it("hands the verbatim summary to whoever asked for it", async () => {
    const seen: unknown[] = [];
    const { fetchImpl } = stub(() => json(routed()));
    await requestSellQuote("NVDA", TOKEN_IN, {
      fetchImpl,
      nowMs: NOW,
      onRouteSummary: (summary) => {
        seen.push(summary);
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tokenIn: TOKEN_ADDRESSES.NVDA });
  });
});

describe("toSellQuoteWire and parseSellQuoteWire", () => {
  it("round-trips a quote without loss", async () => {
    const quote = await sellQuote();
    const parsed = parseSellQuoteWire(toSellQuoteWire({ kind: "quote", quote }));

    expect(parsed.kind).toBe("quote");
    if (parsed.kind !== "quote") return;
    expect(parsed.quote.tokenIn).toBe(quote.tokenIn);
    expect(parsed.quote.usdcOut).toBe(quote.usdcOut);
    expect(parsed.quote.routerAddress).toBe(quote.routerAddress);
  });

  it("refuses a payload naming another router", async () => {
    const quote = await sellQuote();
    const wire = toSellQuoteWire({ kind: "quote", quote });
    const parsed = parseSellQuoteWire({ ...wire, routerAddress: SENDER });

    expect(parsed).toMatchObject({ kind: "failed" });
  });
});

describe("withSellNgnQuote", () => {
  it("joins proceeds, rate and premium onto the quote", async () => {
    const quote = await sellQuote();
    const view = withSellNgnQuote(quote, 1500, 200);

    expect(view.usdcOutNgn).toBeCloseTo(3000, 8);
    expect(view.ngnPerShare).toBeCloseTo(300_000, 4);
    // Execution at reference: no premium.
    expect(view.premiumBps).toBe(0);
    expect(view.feeNgn).toBe(0);
  });

  it("blanks the premium without a reference, never invents one", async () => {
    const quote = await sellQuote();
    expect(withSellNgnQuote(quote, 1500, null).premiumBps).toBeNull();
    expect(withSellNgnQuote(quote, null, 200).usdcOutNgn).toBeNull();
  });
});

describe("buildSellSwap", () => {
  async function buildFor(
    body: () => Response,
    floor: bigint = 1_990_000n,
  ) {
    const quote = await sellQuote();
    const { result, routeSummary } = await requestSellRoute("NVDA", TOKEN_IN, {
      fetchImpl: stub(() => json(routed())).fetchImpl,
      nowMs: NOW,
    });
    if (routeSummary === null || result.kind !== "quote") {
      throw new Error("fixture did not route");
    }

    const { fetchImpl } = stub(body);
    return buildSellSwap(
      { quote, routeSummary, sender: SENDER, minAmountOut: floor },
      { fetchImpl, nowMs: NOW },
    );
  }

  it("builds calldata for the pinned router and no ETH", async () => {
    const builtResult = await buildFor(() => json(built()));
    expect(builtResult.kind).toBe("transaction");
    if (builtResult.kind !== "transaction") return;

    const { transaction: tx } = builtResult;
    expect(tx.to).toBe(KYBERSWAP_ROUTER_ADDRESS);
    expect(tx.value).toBe("0");
    expect(tx.amountIn).toBe(TOKEN_IN);
    expect(tx.amountOut).toBe(2_000_000n);
    // Derived here from the output and the tolerance, not read off the reply.
    expect(tx.minAmountOut).toBe((2_000_000n * 9_950n) / 10_000n);
    expect(tx.data).toMatch(/^0x([0-9a-fA-F]{2})+$/);
    expect(tx.deadline).toBeGreaterThan(Math.floor(NOW / 1000));
  });

  it("refuses a build that disagrees with the quote it came from", async () => {
    for (const body of [
      built({ routerAddress: SENDER }),
      built({ amountIn: "999999" }),
      built({ amountOut: "0" }),
      built({ amountOut: "100" }),
      built({ transactionValue: "1" }),
      built({ data: "0xzz" }),
      built({ data: "0x" }),
    ]) {
      const result = await buildFor(() => json(body));
      expect(result.kind, JSON.stringify(body)).toBe("refused");
    }
  });

  it("fails rather than builds on transport and garbage", async () => {
    expect(await buildFor(() => new Response("", { status: 500 }))).toMatchObject(
      { kind: "failed" },
    );
    expect(
      await buildFor(() => new Response("not json", { status: 200 })),
    ).toMatchObject({ kind: "failed" });
  });

  it("refuses a sender that is not a wallet address", async () => {
    const quote = await sellQuote();
    const { routeSummary } = await requestSellRoute("NVDA", TOKEN_IN, {
      fetchImpl: stub(() => json(routed())).fetchImpl,
      nowMs: NOW,
    });
    if (routeSummary === null) throw new Error("fixture did not route");

    const { fetchImpl } = stub(() => json(built()));
    const result = await buildSellSwap(
      { quote, routeSummary, sender: "not-an-address", minAmountOut: 1_990_000n },
      { fetchImpl, nowMs: NOW },
    );
    expect(result).toMatchObject({ kind: "refused" });
  });
});

describe("prepareSellSwap", () => {
  it("refuses a fresh route worse than the shown floor as price-moved", async () => {
    const quote = await sellQuote();
    // The shown floor is the full quoted output: any adverse tick refuses.
    const { fetchImpl } = stub(() => json(routed({ amountOut: "1999999" })));
    const result = await prepareSellSwap(
      {
        symbol: "NVDA",
        tokenIn: TOKEN_IN,
        sender: SENDER,
        minAmountOut: quote.usdcOut,
      },
      { fetchImpl, nowMs: NOW },
    );

    expect(result.kind).toBe("refused");
    if (result.kind !== "transaction") {
      expect(isSellPriceMoved(result)).toBe(true);
      expect(isSellNoRoute(result)).toBe(false);
    }
  });
});

describe("parseSellBuildBody", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    symbol: "NVDA",
    amountIn: TOKEN_IN.toString(),
    sender: SENDER,
    minAmountOut: "1990000",
    ...overrides,
  });

  it("accepts four bounded fields and canonicalises the sender", () => {
    const parsed = parseSellBuildBody(body({ sender: SENDER.toLowerCase() }));
    expect(parsed).toMatchObject({ ok: true, symbol: "NVDA", tokenIn: TOKEN_IN });
    if (parsed.ok) expect(parsed.sender).toBe(SENDER);
  });

  it("names the field at fault", () => {
    expect(parseSellBuildBody(null)).toMatchObject({ ok: false });
    expect(parseSellBuildBody(body({ symbol: "COIN" }))).toMatchObject({
      ok: false,
    });
    expect(parseSellBuildBody(body({ sender: "0x0" }))).toMatchObject({
      ok: false,
    });
    // Zero is refused rather than read as "no floor".
    expect(parseSellBuildBody(body({ minAmountOut: "0" }))).toMatchObject({
      ok: false,
    });
  });
});

describe("toSellSwapWire and parseSellSwapWire", () => {
  it("round-trips what a wallet must be handed", async () => {
    const quote = await sellQuote();
    const { routeSummary } = await requestSellRoute("NVDA", TOKEN_IN, {
      fetchImpl: stub(() => json(routed())).fetchImpl,
      nowMs: NOW,
    });
    if (routeSummary === null) throw new Error("fixture did not route");

    const { fetchImpl } = stub(() => json(built()));
    const result = await buildSellSwap(
      { quote, routeSummary, sender: SENDER, minAmountOut: 1_990_000n },
      { fetchImpl, nowMs: NOW },
    );
    if (result.kind !== "transaction") throw new Error("fixture did not build");

    const parsed = parseSellSwapWire(toSellSwapWire(result.transaction));
    expect(parsed.kind).toBe("transaction");
    if (parsed.kind !== "transaction") return;
    expect(parsed.transaction.to).toBe(KYBERSWAP_ROUTER_ADDRESS);
    expect(parsed.transaction.value).toBe("0");
    expect(parsed.transaction.minAmountOut).toBe(result.transaction.minAmountOut);
  });

  it("treats a foreign router as unsafe and a short floor as unreadable", async () => {
    const quote = await sellQuote();
    const { routeSummary } = await requestSellRoute("NVDA", TOKEN_IN, {
      fetchImpl: stub(() => json(routed())).fetchImpl,
      nowMs: NOW,
    });
    if (routeSummary === null) throw new Error("fixture did not route");

    const { fetchImpl } = stub(() => json(built()));
    const result = await buildSellSwap(
      { quote, routeSummary, sender: SENDER, minAmountOut: 1_990_000n },
      { fetchImpl, nowMs: NOW },
    );
    if (result.kind !== "transaction") throw new Error("fixture did not build");

    const wire = toSellSwapWire(result.transaction);
    expect(parseSellSwapWire({ ...wire, to: SENDER })).toMatchObject({
      kind: "unsafe",
    });
    expect(
      parseSellSwapWire({
        ...wire,
        minAmountOut: (result.transaction.amountOut + 1n).toString(),
      }),
    ).toMatchObject({ kind: "unsafe" });
  });
});
