import { NextResponse } from "next/server";

import {
  parseSellQuoteParams,
  requestSellQuote,
  toSellQuoteWire,
} from "@/lib/sell";

/**
 * Sell-quote proxy: `GET /api/sell-quote?symbol=NVDA&amountIn=1000000`.
 *
 * `amountIn` is token base units (the token's own 8 decimals) — what the
 * seller spends. The answer prices it in USDC.
 *
 * The browser never calls KyberSwap directly, for the same reason it never
 * calls the rate provider directly — the `x-client-id` header and any future
 * key stay on the server, and there is one place to put a timeout, a cache
 * header and a log line.
 *
 * Read-only, and no wallet is involved. Nothing here approves, signs or
 * submits anything; a quote is a question.
 *
 * Unauthenticated, like `/api/quote` and for the same reason: there is no
 * session to authenticate against at the point this is called. What stands in
 * for auth is the closed input surface — `parseSellQuoteParams` accepts one
 * of ten registry keys and an integer inside a bounded band, so the route
 * cannot be pointed at an arbitrary token, chain or amount. Only published
 * tokens are sellable: the address is resolved server-side from
 * the registry, where the `0xb2…` shape assertion already ran.
 *
 * The validation itself lives in `lib/sell.ts` so the offline suite covers
 * it. This file is the HTTP shell: parse, forward, choose a status.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  const params = parseSellQuoteParams(new URL(request.url).searchParams);

  if (!params.ok) {
    return NextResponse.json(
      { kind: "failed", error: params.reason },
      { status: 400, headers: NO_STORE },
    );
  }

  const { symbol, tokenIn } = params;
  const result = await requestSellQuote(symbol, tokenIn);

  if (result.kind === "failed") {
    // Logged with the reason, answered without it: upstream text is for us,
    // and the browser only needs to know it can retry.
    console.error(`[sell-quote] ${symbol} failed — ${result.detail}`);
    return NextResponse.json(toSellQuoteWire(result), {
      status: 502,
      headers: NO_STORE,
    });
  }

  return NextResponse.json(toSellQuoteWire(result), { headers: NO_STORE });
}
