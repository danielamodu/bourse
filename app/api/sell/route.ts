import { NextResponse } from "next/server";

import {
  isSellNoRoute,
  isSellPriceMoved,
  parseSellBuildBody,
  prepareSellSwap,
  toSellSwapWire,
} from "@/lib/sell";

/**
 * Sell builder: `POST /api/sell` with `{ symbol, amountIn, sender,
 * minAmountOut }`.
 *
 * `amountIn` is token base units spent; `minAmountOut` is the USDC floor the
 * browser was shown, in USDC base units. Returns an unsigned transaction. It
 * signs nothing, submits nothing and holds no key — the wallet does that.
 * What this endpoint decides is *what* the user will be asked to sign, which
 * is why every check in `lib/sell.ts` fails closed.
 *
 * WHAT A REQUEST CANNOT ASK FOR.
 *
 * - **A recipient.** Not read here, not read in `lib/sell.ts`;
 *   `buildSellSwap` sets `recipient` to `sender`. The USDC proceeds go back
 *   to the seller, and there is no request that says otherwise.
 * - **A router.** `to` is the pinned constant. The build response's own
 *   `routerAddress` is compared against that pin and then discarded. In a
 *   sell this address pulls the *stock* under the user's approval, so letting
 *   a response choose it would be the same worst outcome wearing the other
 *   token.
 * - **A token address.** `symbol` is one of four registry keys and the
 *   address is resolved server-side, from the registry, which is where the
 *   `0xb2…` shape assertion already ran. Only the four tradeable tokens are
 *   sellable.
 *
 * Unauthenticated, like the buy routes and for the same reason. What stands
 * in for auth is the closed input surface — four fields, three of them
 * bounded by `parseSellBuildBody`, forwarding nothing unbounded to a third
 * party under our client id. The output is calldata that is worthless
 * without the sender's own signature.
 *
 * The decisions live in `lib/sell.ts` so the offline suite covers them. This
 * file is the HTTP shell: parse, forward, choose a status.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { kind: "failed", error: "body must be JSON" },
      { status: 400, headers: NO_STORE },
    );
  }

  const params = parseSellBuildBody(body);

  if (!params.ok) {
    return NextResponse.json(
      { kind: "failed", error: params.reason },
      { status: 400, headers: NO_STORE },
    );
  }

  const { symbol, tokenIn, sender, minAmountOut } = params;
  const result = await prepareSellSwap({
    symbol,
    tokenIn,
    sender,
    minAmountOut,
  });

  if (result.kind === "transaction") {
    return NextResponse.json(toSellSwapWire(result.transaction), {
      headers: NO_STORE,
    });
  }

  // 409, and its own kind: the price moved between the quote the user read
  // and the route we just fetched. The panel's answer is to quote again and
  // show the new number.
  if (isSellPriceMoved(result)) {
    console.warn(`[sell] ${symbol} re-quote — ${result.detail}`);
    return NextResponse.json(
      { kind: "price-moved", error: "the price moved; request a new quote" },
      { status: 409, headers: NO_STORE },
    );
  }

  // 422: well formed, and no route for it at this size. A market condition.
  if (isSellNoRoute(result)) {
    return NextResponse.json(
      { kind: "no-route", error: "no route at this size" },
      { status: 422, headers: NO_STORE },
    );
  }

  // Everything else is a build we would not sign. Logged with the detail,
  // answered without it.
  console.error(`[sell] ${symbol} ${result.kind} — ${result.detail}`);

  return NextResponse.json(
    { kind: "failed", error: "the sale could not be built" },
    { status: 502, headers: NO_STORE },
  );
}
