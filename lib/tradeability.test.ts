import { describe, expect, it } from "vitest";

import {
  PRICE_IMPACT_BUDGET_BPS,
  type Quote,
  type QuoteResult,
} from "@/lib/quote";
import {
  PROBE_USDC_UNITS,
  classifyQuote,
  probeTradeability,
  reportQuote,
  unknownTradeability,
} from "@/lib/tradeability";
import {
  QUOTABLE_SYMBOLS,
  STOCK_SYMBOLS,
  TOKEN_ADDRESSES,
  USDC_ADDRESS,
  type QuotableSymbol,
} from "@/lib/tokens";

/**
 * Offline. `probeTradeability` takes a `fetchImpl`, so nothing here reaches
 * KyberSwap and no assertion depends on which pools exist today — which is the
 * point of the module: the answer is measured at request time, not authored.
 */

const NOW = 1_757_000_000_000;

/** A priced route, with any figure replaceable. */
function quoteResult(overrides: Partial<Quote> = {}): QuoteResult {
  return {
    kind: "quote",
    quote: {
      symbol: "NVDA",
      usdcIn: 30_000_000n,
      usdIn: 30,
      unitsOut: 5_000_000n,
      shares: 0.05,
      usdPerShare: 600,
      priceImpactBps: 20,
      gasUsd: 0.004,
      routerAddress: null,
      receivedAtMs: NOW,
      expiresAtMs: NOW + 30_000,
      ...overrides,
    },
  };
}

describe("classifyQuote", () => {
  it("calls a route inside the impact budget tradeable", () => {
    expect(classifyQuote(quoteResult({ priceImpactBps: 0 }))).toBe("tradeable");
    expect(classifyQuote(quoteResult({ priceImpactBps: 20 }))).toBe("tradeable");
  });

  it("includes the budget itself", () => {
    expect(PRICE_IMPACT_BUDGET_BPS).toBe(300);

    expect(
      classifyQuote(quoteResult({ priceImpactBps: PRICE_IMPACT_BUDGET_BPS })),
    ).toBe("tradeable");

    expect(
      classifyQuote(
        quoteResult({ priceImpactBps: PRICE_IMPACT_BUDGET_BPS + 1 }),
      ),
    ).toBe("not-tradeable");
  });

  it("treats an unpriced impact as unknown, not as tradeable", () => {
    // Every buy has to show an impact figure. "Unknown" is not a figure, so a
    // route we cannot price is a route we do not offer — but it is also not
    // evidence that the market is missing.
    expect(classifyQuote(quoteResult({ priceImpactBps: null }))).toBe("unknown");
  });

  it("reads no liquidity as the market and a failure as ours", () => {
    expect(classifyQuote({ kind: "no-liquidity", detail: "404" })).toBe(
      "not-tradeable",
    );
    expect(classifyQuote({ kind: "failed", detail: "HTTP 500" })).toBe(
      "unknown",
    );
  });
});

describe("reportQuote", () => {
  it("carries the traded price and impact through", () => {
    const report = reportQuote(
      quoteResult({ usdPerShare: 612.5, priceImpactBps: 42 }),
    );

    expect(report).toEqual({
      verdict: "tradeable",
      usdPerShare: 612.5,
      priceImpactBps: 42,
    });
  });

  it("reports figures as null when there was no quote", () => {
    for (const result of [
      { kind: "no-liquidity", detail: "404" },
      { kind: "failed", detail: "HTTP 500" },
    ] satisfies QuoteResult[]) {
      const report = reportQuote(result);

      expect(report.verdict, result.kind).toBe(
        result.kind === "failed" ? "unknown" : "not-tradeable",
      );
      expect(report.usdPerShare, result.kind).toBeNull();
      expect(report.priceImpactBps, result.kind).toBeNull();
    }
  });

  it("keeps the price even when the verdict is not tradeable", () => {
    // A wide route is still a real price, and the card is entitled to show what
    // the market is charging while refusing to offer a buy at it.
    const report = reportQuote(
      quoteResult({ usdPerShare: 640, priceImpactBps: 1_200 }),
    );

    expect(report.verdict).toBe("not-tradeable");
    expect(report.usdPerShare).toBe(640);
    expect(report.priceImpactBps).toBe(1_200);
  });
});

/** Echoes back whatever it was asked about, at a chosen output valuation. */
function routeFor(symbol: QuotableSymbol, amountOutUsd: string): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      message: "successfully",
      data: {
        routeSummary: {
          tokenIn: USDC_ADDRESS,
          amountIn: PROBE_USDC_UNITS.toString(),
          amountInUsd: "30",
          tokenOut: TOKEN_ADDRESSES[symbol],
          amountOut: "5000000",
          amountOutUsd,
          gasUsd: "0.004",
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * A KyberSwap that answers per token, and records which tokens it was asked
 * about — the probe is supposed to ask about four addresses, not thirteen.
 */
function aggregator(answer: (symbol: QuotableSymbol, url: URL) => Response): {
  fetchImpl: typeof fetch;
  asked: QuotableSymbol[];
} {
  const asked: QuotableSymbol[] = [];

  const fetchImpl = ((input: URL | string) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const tokenOut = (url.searchParams.get("tokenOut") ?? "").toLowerCase();

    const symbol = QUOTABLE_SYMBOLS.find(
      (candidate) => TOKEN_ADDRESSES[candidate].toLowerCase() === tokenOut,
    );

    if (symbol === undefined) {
      throw new Error(`asked about an unknown tokenOut: ${tokenOut}`);
    }

    asked.push(symbol);
    return Promise.resolve(answer(symbol, url));
  }) as unknown as typeof fetch;

  return { fetchImpl, asked };
}

/** $30 in, priced out at $29.94 — 20bps, comfortably inside the budget. */
const INSIDE_BUDGET = "29.94";

describe("probeTradeability", () => {
  it("reports on all thirteen while asking about four", async () => {
    const { fetchImpl, asked } = aggregator((symbol) =>
      routeFor(symbol, INSIDE_BUDGET),
    );

    const reports = await probeTradeability({ fetchImpl });

    expect(Object.keys(reports)).toHaveLength(STOCK_SYMBOLS.length);
    expect(asked).toHaveLength(QUOTABLE_SYMBOLS.length);
    expect([...asked].sort()).toEqual([...QUOTABLE_SYMBOLS].sort());
  });

  it("asks at the $30 reference ticket", async () => {
    const amounts: string[] = [];
    const { fetchImpl } = aggregator((symbol, url) => {
      amounts.push(url.searchParams.get("amountIn") ?? "");
      return routeFor(symbol, INSIDE_BUDGET);
    });

    await probeTradeability({ fetchImpl });

    // Impact is a function of order size, so the verdict is only meaningful at
    // a stated one. ₦50,000 is about $30.
    expect(PROBE_USDC_UNITS).toBe(30_000_000n);
    expect([...new Set(amounts)]).toEqual(["30000000"]);
  });

  it("calls a quoted token tradeable and an unpublished one unpublished", async () => {
    const { fetchImpl } = aggregator((symbol) =>
      routeFor(symbol, INSIDE_BUDGET),
    );

    const reports = await probeTradeability({ fetchImpl });

    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(reports[symbol].verdict, symbol).toBe("tradeable");
      expect(reports[symbol].usdPerShare, symbol).toBeCloseTo(600, 9);
      expect(reports[symbol].priceImpactBps, symbol).toBe(20);
    }

    // TSLA is issued, has a working feed, and has no published address — so
    // there is nothing to ask, and the answer is not "no market".
    expect(reports.TSLA.verdict).toBe("unpublished");
    expect(reports.TSLA.usdPerShare).toBeNull();
    expect(reports.MSFT.verdict).toBe("unpublished");
  });

  it("keeps one token's answer from colouring the others", async () => {
    const { fetchImpl } = aggregator((symbol) =>
      symbol === "META"
        ? new Response("", { status: 404 })
        : routeFor(symbol, INSIDE_BUDGET),
    );

    const reports = await probeTradeability({ fetchImpl });

    expect(reports.META.verdict).toBe("not-tradeable");
    expect(reports.NVDA.verdict).toBe("tradeable");
    expect(reports.GOOGL.verdict).toBe("tradeable");
    expect(reports.AAPL.verdict).toBe("tradeable");
  });

  it("refuses a route that would cost too much to cross", async () => {
    // $30 in, valued at $20 out: 3,334bps, more than ten times the budget. Exactly
    // 3,333⅓ in real arithmetic, rounded up because impact never rounds toward the
    // figure that flatters the trade — see `ceilBps` in lib/price.ts.
    const { fetchImpl } = aggregator((symbol) => routeFor(symbol, "20"));

    const reports = await probeTradeability({ fetchImpl });

    expect(reports.NVDA.verdict).toBe("not-tradeable");
    // The price is still reported. Refusing to offer a buy is not a reason to
    // hide what the market is charging.
    expect(reports.NVDA.priceImpactBps).toBe(3_334);
    expect(reports.NVDA.usdPerShare).toBeCloseTo(600, 9);
  });

  it("says unknown, never not-tradeable, when the request fails", async () => {
    const { fetchImpl } = aggregator(() => {
      throw new Error("connect ETIMEDOUT");
    });

    const reports = await probeTradeability({ fetchImpl });

    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(reports[symbol].verdict, symbol).toBe("unknown");
    }

    // A dead aggregator says nothing about the nine, whose answer comes from the
    // registry and needs no request.
    expect(reports.TSLA.verdict).toBe("unpublished");
  });
});

describe("unknownTradeability", () => {
  it("covers every symbol before any probe has run", () => {
    const reports = unknownTradeability();

    expect(Object.keys(reports)).toHaveLength(STOCK_SYMBOLS.length);

    for (const symbol of STOCK_SYMBOLS) {
      expect(reports[symbol].usdPerShare, symbol).toBeNull();
      expect(reports[symbol].priceImpactBps, symbol).toBeNull();
    }
  });

  it("distinguishes not having asked from having no address", () => {
    const reports = unknownTradeability();

    // Not having asked is not the same as having been told no.
    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(reports[symbol].verdict, symbol).toBe("unknown");
    }

    expect(reports.TSLA.verdict).toBe("unpublished");
    expect(reports.SPCX.verdict).toBe("unpublished");
  });
});
