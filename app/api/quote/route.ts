import { NextResponse } from "next/server";

import { parseQuoteParams, requestQuote, toQuoteWire } from "@/lib/quote";

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
 * surface is closed — `parseQuoteParams` accepts one of four registry keys and an
 * integer inside a bounded band, so the route cannot be pointed at an arbitrary
 * token, chain or amount, and cannot be made to forward an unbounded string to a
 * third party under our client id. It is a read of public market data either way.
 *
 * The validation itself lives in `lib/quote.ts` so the offline suite covers it.
 * This file is the HTTP shell: parse, forward, choose a status.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  const params = parseQuoteParams(new URL(request.url).searchParams);

  if (!params.ok) {
    return NextResponse.json(
      { kind: "failed", error: params.reason },
      { status: 400, headers: NO_STORE },
    );
  }

  const { symbol, usdcIn } = params;
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
