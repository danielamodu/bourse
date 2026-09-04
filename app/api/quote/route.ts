import { NextResponse } from "next/server";

import {
  MAX_QUOTE_USDC_UNITS,
  MIN_QUOTE_USDC_UNITS,
  requestQuote,
  toQuoteWire,
} from "@/lib/quote";
import { QUOTABLE_SYMBOLS, type QuotableSymbol } from "@/lib/tokens";

/**
 * Quote proxy: `GET /api/quote?symbol=NVDA&amountIn=30000000`.
 *
 * The browser never calls KyberSwap directly, for the same reason it never calls
 * the rate provider directly — the `x-client-id` header and any future key stay
 * on the server, and there is one place to put a timeout, a cache header and a
 * log line.
 *
 * Read-only, and no wallet is involved. Nothing here approves, signs or submits
 * anything; a quote is a question.
 *
 * Unauthenticated, deliberately and in line with `/api/ngn-rate`: `/markets` is
 * browseable with no wallet connected, so there is no session to authenticate
 * against at the point this is called. What stands in for auth is that the input
 * surface is closed — `symbol` must be one of four registry keys and `amountIn`
 * must be an integer inside a sane band, so the route cannot be pointed at an
 * arbitrary token, chain or amount. It is a read of public market data either way.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const symbol = params.get("symbol");
  if (symbol === null || !isQuotable(symbol)) {
    return bad(`symbol must be one of ${QUOTABLE_SYMBOLS.join(", ")}`);
  }

  const amountIn = params.get("amountIn");
  if (amountIn === null || !/^\d+$/.test(amountIn)) {
    return bad("amountIn must be an integer number of USDC base units");
  }

  const usdcIn = BigInt(amountIn);
  if (usdcIn < MIN_QUOTE_USDC_UNITS || usdcIn > MAX_QUOTE_USDC_UNITS) {
    return bad(
      `amountIn must be between ${MIN_QUOTE_USDC_UNITS} and ${MAX_QUOTE_USDC_UNITS} USDC base units`,
    );
  }

  const result = await requestQuote(symbol, usdcIn);

  if (result.kind === "failed") {
    // Logged with the reason, answered without it: upstream text is for us, and
    // the browser only needs to know it can retry.
    console.error(`[quote] ${symbol} failed — ${result.detail}`);
    return NextResponse.json(toQuoteWire(result), {
      status: 502,
      headers: NO_STORE,
    });
  }

  return NextResponse.json(toQuoteWire(result), { headers: NO_STORE });
}

function isQuotable(value: string): value is QuotableSymbol {
  return (QUOTABLE_SYMBOLS as readonly string[]).includes(value);
}

function bad(reason: string) {
  return NextResponse.json(
    { kind: "failed", error: reason },
    { status: 400, headers: NO_STORE },
  );
}
