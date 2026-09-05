import type { Address } from "viem";

import { parseAddress } from "@/lib/address";
import {
  KYBERSWAP_ROUTER_ADDRESS,
  ROUTER_ABSENT_DETAIL,
  ROUTER_MISMATCH_DETAIL,
  clientId,
  parseQuoteParams,
  requestQuote,
  sameAddress,
  toBigInt,
  type Quote,
  type QuoteResult,
} from "@/lib/quote";
import type { QuotableSymbol } from "@/lib/tokens";

/**
 * The swap transaction, built by KyberSwap and checked by us.
 *
 * `lib/quote.ts` asks what a trade would cost. This asks for the calldata that
 * performs it. Nothing here signs, submits or holds a key: the output is an
 * unsigned `{ to, data, value }` that a wallet is asked to sign in Part B2, and
 * every field of it is either derived here or checked against something we already
 * knew before it is handed on.
 *
 * WHY EVERY GUARD FAILS CLOSED. A quote that is wrong shows a wrong number. A
 * transaction that is wrong moves money, once, irreversibly, with the user's own
 * signature on it. So a build response that disagrees with the quote it was built
 * from in any respect is refused rather than repaired, and the refusal carries a
 * machine-readable code so the panel can say something specific about it.
 *
 * WHAT WE NEVER DO IS READ THE CALLDATA. It is checked for shape - 0x, hex, whole
 * bytes - and otherwise treated as opaque. Decoding it to "verify" the swap would
 * mean re-implementing KyberSwap's encoder well enough to disagree with it, and
 * being wrong about that would reject good transactions and, far worse, teach us to
 * trust a decode. The protections that actually hold are elsewhere and are
 * structural: the calldata is only ever sent to {@link KYBERSWAP_ROUTER_ADDRESS},
 * the pinned address the user's allowance names; `recipient` is the sender and is
 * never read from a request; and the transaction carries no ETH value.
 */

/**
 * The build endpoint. Exported for the same reason as `KYBERSWAP_ROUTES_URL`: so
 * `verify/build.verify.ts` posts to exactly what the app posts to.
 */
export const KYBERSWAP_BUILD_URL =
  "https://aggregator-api.kyberswap.com/base/api/v1/route/build";

/* ------------------------------------------------------------------ *
 * Refusal codes.
 *
 * Same convention as the router details in `lib/quote.ts`: a detail reads
 * `code: prose`. The code is what a caller dispatches on, the prose is what a
 * log line needs, and they travel together so no caller ends up matching on a
 * sentence someone will later reword.
 * ------------------------------------------------------------------ */

/** The aggregator has no route at this size. A market answer, not a fault. */
export const NO_ROUTE_DETAIL = "no-route-at-this-size";

/** A route we approved, but with no `routeSummary` to hand to the build call. */
export const ROUTE_SUMMARY_ABSENT_DETAIL = "route-summary-absent";

/**
 * The fresh route is worse than the quote the user was shown.
 *
 * The one refusal that is an ordinary condition rather than a disagreement: prices
 * move, and the answer is to quote again, not to retry the same build.
 */
export const PRICE_MOVED_DETAIL = "price-moved-re-quote";

/** `sender` is not an address we will build a transaction for. */
export const SENDER_INVALID_DETAIL = "build-sender-invalid";

/** The tolerance asked for is outside the band this module will encode. */
export const SLIPPAGE_INVALID_DETAIL = "build-slippage-invalid";

/** The build did not state the `amountIn` its route was quoted at. */
export const AMOUNT_IN_MISMATCH_DETAIL = "build-amount-in-mismatch";

/** `amountOut` was missing, unreadable, or not a positive integer. */
export const AMOUNT_OUT_UNREADABLE_DETAIL = "build-amount-out-unreadable";

/** The build returns less than the shown quote's floor allows for. */
export const AMOUNT_OUT_SHORTFALL_DETAIL = "build-amount-out-shortfall";

/** The transaction would send ETH. We are spending an ERC-20. */
export const TRANSACTION_VALUE_DETAIL = "build-transaction-value-not-zero";

/** `data` is not 0x-prefixed, whole-byte hex. */
export const CALLDATA_MALFORMED_DETAIL = "build-calldata-malformed";

/**
 * Slippage tolerance, in basis points, when a caller does not name one.
 *
 * 50bps. Not a guess at how much a price moves — it is how much adverse movement
 * the user is agreeing to eat between signing and mining, and it is encoded into
 * the calldata as a minimum out. Set it too tight and ordinary block-to-block
 * movement reverts the swap after the user has paid gas; set it too loose and a
 * sandwich has room to work. Half a percent is the usual floor for a liquid pair,
 * and these four are the liquid ones.
 */
export const SLIPPAGE_BPS = 50;

/**
 * The most tolerance this module will encode.
 *
 * 300bps, which is the same number as `EXECUTION_COST_BUDGET_BPS` and deliberately
 * not that constant. They answer different questions — one is how expensive a
 * round trip may look before we stop offering to buy, the other is how much worse
 * than quoted a signed transaction may settle — and wiring them together would mean
 * a later change to either silently moved the other. Same trap as the two
 * `decimals()` in `lib/tokens.ts`, and handled the same way.
 */
export const MAX_SLIPPAGE_BPS = 300;

/**
 * Seconds of validity encoded in the swap deadline.
 *
 * Longer than the quote's 30s TTL on purpose: `QUOTE_TTL_MS` decides how long we
 * keep showing a number, this decides how long the signed transaction stays valid
 * once a wallet has it. A user reading a confirmation prompt, switching apps to
 * approve, and coming back can easily spend more than thirty seconds, and a
 * deadline that expires mid-signature turns into a revert the user pays for.
 */
export const SWAP_DEADLINE_SEC = 300;

/** Basis points denominator, as a bigint because it divides token amounts. */
const BPS_DENOMINATOR = 10_000n;

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * `0x` plus whole bytes of hex, and nothing else.
 *
 * The `{2}` is the point: it rejects an odd number of hex characters, which cannot
 * be bytes, and the `+` rejects a bare `0x`, which is a transaction that calls a
 * contract with no function selector.
 */
const CALLDATA_SHAPE = /^0x([0-9a-fA-F]{2})+$/;

/** Bytes on the wire. */
type Hex = `0x${string}`;

/**
 * An unsigned transaction, plus the figures the panel has to show beside it.
 *
 * Everything here is either a constant of ours, a value we derived, or a value we
 * checked against the quote it was built from. Nothing is passed through on the
 * aggregator's word alone.
 */
export type SwapTransaction = {
  symbol: QuotableSymbol;
  /**
   * Always {@link KYBERSWAP_ROUTER_ADDRESS} — our pinned constant, never the
   * address the response echoed. The echo is checked against the pin and then
   * discarded, so there is no path by which a response chooses its own `to`.
   */
  to: string;
  /** Opaque calldata. Shape-checked, never decoded. */
  data: Hex;
  /**
   * Zero, as a literal type. Widening this to `string` is the edit that would let
   * a swap carry ETH, so the type refuses it rather than a review having to catch
   * it.
   */
  value: "0";
  /** USDC base units in. Equal to the quote's `usdcIn`, and echoed by the build. */
  amountIn: bigint;
  /** Token units the built route returns, in the token's own decimals. */
  amountOut: bigint;
  /** `amountOut` less the tolerance, computed here — see {@link minAmountOutFor}. */
  minAmountOut: bigint;
  /** The tolerance actually encoded, in basis points. */
  slippageBps: number;
  /** Gas units the aggregator estimates, or null when it did not say. */
  gas: bigint | null;
  /** Unix seconds. The deadline sent to the build call, echoed for the panel. */
  deadline: number;
  /** Unix ms: the quote's expiry, carried through so the panel counts one clock. */
  expiresAt: number;
};

/**
 * The same three-armed shape as {@link QuoteResult}, for the same reason: a build
 * boundary that throws surfaces to a user as a blank panel.
 *
 * `refused` and `failed` are a real distinction, not two words for an error.
 * `failed` means we could not get an answer we trust — network, HTTP, garbage JSON —
 * and retrying is reasonable. `refused` means we got an answer and it disagreed
 * with something we already knew, so retrying the same request is not.
 */
export type BuildResult =
  | { kind: "transaction"; transaction: SwapTransaction }
  | { kind: "refused"; detail: string }
  | { kind: "failed"; detail: string };

export type BuildOptions = {
  /** Injected in tests so the suite never touches the network. */
  fetchImpl?: typeof fetch;
  /** Injected so the deadline and the quote's expiry are both assertable. */
  nowMs?: number;
};

/** A quote, with the routing data needed to build it. */
export type RoutedQuote = {
  result: QuoteResult;
  /** Verbatim, as KyberSwap sent it. Null unless `result` is a quote. */
  routeSummary: Record<string, unknown> | null;
};

export type BuildSwapParams = {
  /** The quote the summary came from: supplies symbol, `amountIn` and expiry. */
  quote: Quote;
  /** Verbatim from {@link requestRoute}. Never rebuilt and never reshaped. */
  routeSummary: Record<string, unknown>;
  /** The signer. Becomes `recipient` too; see the module note. */
  sender: string;
  /** Token units: the floor under the quote the user was actually shown. */
  minAmountOut: bigint;
  /** Defaults to {@link SLIPPAGE_BPS}. */
  slippageBps?: number;
};

export type PrepareSwapParams = {
  symbol: QuotableSymbol;
  usdcIn: bigint;
  sender: string;
  minAmountOut: bigint;
  slippageBps?: number;
};

/** In the band this module will encode, and a whole number of basis points. */
function isSlippageBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= MAX_SLIPPAGE_BPS;
}

/** `amount` less `bps`, floored. Callers check the band first. */
function lessBps(amount: bigint, bps: number): bigint {
  return (amount * (BPS_DENOMINATOR - BigInt(bps))) / BPS_DENOMINATOR;
}

/**
 * The least a swap may return and still be the trade the user agreed to.
 *
 * Derived here, from `amountOut` and the tolerance, and never read off a response.
 * That is the whole point of the function: `minAmountOut` is the number that
 * decides whether a swap reverts or settles, so the figure the panel shows has to
 * be one we computed from inputs we can see, not one the API asserted about
 * calldata we do not decode.
 *
 * Integer division floors, which puts the rounding error — at most one base unit,
 * a hundred-millionth of a share at these tokens' 8 decimals — on the side of
 * claiming slightly less protection than the calldata carries. The opposite
 * rounding would have us print a floor the transaction does not actually enforce.
 *
 * Null rather than a throw on bad input, so a caller has to handle it: a negative
 * amount or an out-of-band tolerance is a programming error, and this is called on
 * the path to a signature.
 */
export function minAmountOutFor(
  amountOut: bigint,
  slippageBps: number,
): bigint | null {
  if (amountOut < 0n) return null;
  if (!isSlippageBps(slippageBps)) return null;

  return lessBps(amountOut, slippageBps);
}

/**
 * A quote, and the `routeSummary` it came from.
 *
 * `requestQuote` is the only thing here that talks to `/routes`, and this does not
 * reimplement any of it: same guards, same classification, same result. It only
 * opts into the summary passthrough, because `POST /route/build` needs that object
 * exactly as KyberSwap sent it and a `Quote` deliberately does not carry it.
 *
 * The capture goes into a holder object rather than a `let`. TypeScript's
 * control-flow analysis does not track assignments made inside a callback, so a
 * `let summary: T | null = null` written only in the callback still narrows to
 * `null` at the read below, however plainly it was assigned.
 */
export async function requestRoute(
  symbol: QuotableSymbol,
  usdcIn: bigint,
  options: BuildOptions = {},
): Promise<RoutedQuote> {
  const captured: { summary: Record<string, unknown> | null } = {
    summary: null,
  };

  const result = await requestQuote(symbol, usdcIn, {
    fetchImpl: options.fetchImpl,
    nowMs: options.nowMs,
    onRouteSummary: (summary) => {
      captured.summary = summary;
    },
  });

  return { result, routeSummary: captured.summary };
}

/**
 * Asks KyberSwap to encode a route it already quoted, and checks what comes back.
 *
 * Never throws. Two things are settled before a request goes out — the sender and
 * the tolerance — because both are ours to get right and neither is worth a round
 * trip to discover.
 */
export async function buildSwap(
  params: BuildSwapParams,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now();
  const slippageBps = params.slippageBps ?? SLIPPAGE_BPS;

  /*
   * The sender is canonicalised here, not trusted from the caller.
   *
   * It is about to be sent as both `sender` and `recipient`, which makes it the
   * account every share bought by this transaction lands in. A mangled address
   * does not fail loudly — it buys stock for an account nobody holds the key to —
   * so `parseAddress` runs its EIP-55 check and this refuses rather than builds.
   */
  const sender = parseAddress(params.sender);
  if (sender === null) {
    return {
      kind: "refused",
      detail: `${SENDER_INVALID_DETAIL}: ${String(params.sender)} is not an address we will build for`,
    };
  }

  if (!isSlippageBps(slippageBps)) {
    return {
      kind: "refused",
      detail: `${SLIPPAGE_INVALID_DETAIL}: ${slippageBps} is outside 0-${MAX_SLIPPAGE_BPS}bps`,
    };
  }

  const deadline = Math.floor(nowMs / 1000) + SWAP_DEADLINE_SEC;

  let response: Response;
  try {
    response = await fetchImpl(KYBERSWAP_BUILD_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": clientId(),
      },
      body: JSON.stringify({
        // Verbatim. The aggregator described a route; this is us handing that
        // description back and asking for it encoded, legs and all.
        routeSummary: params.routeSummary,
        sender,
        // Set here, from the sender, and never read from a request. This is the
        // line that makes it impossible to point the endpoint at someone else's
        // wallet: there is no input that reaches it.
        recipient: sender,
        slippageTolerance: slippageBps,
        deadline,
        source: clientId(),
      }),
      cache: "no-store",
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    return { kind: "failed", detail: `request threw: ${errorMessage(cause)}` };
  }

  if (!response.ok) {
    return { kind: "failed", detail: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return { kind: "failed", detail: `malformed JSON: ${errorMessage(cause)}` };
  }

  return interpretBuild(body, {
    symbol: params.quote.symbol,
    amountIn: params.quote.usdcIn,
    floor: params.minAmountOut,
    slippageBps,
    deadline,
    expiresAt: params.quote.expiresAtMs,
  });
}

/**
 * Quote and build, in one call: what `/api/build` does.
 *
 * A fresh route, because calldata has to encode a route that exists now — the
 * summary shown to the user thirty seconds ago describes pool state that may have
 * moved. So the route is re-fetched and then checked against the floor derived from
 * the quote the user was actually looking at.
 *
 * That check is the reason this orchestration lives in `/lib` rather than in the
 * route handler: it is the decision that stops us silently handing someone a worse
 * trade than the one they read, and CLAUDE.md keeps decisions where the offline
 * suite can reach them.
 *
 * There are two floor checks on this path and they are not the same check.
 * This one compares the *fresh route's* output against the floor — has the price
 * moved since the quote, before we spend a build call on it. The one inside
 * {@link buildSwap} compares the *encoded* route's output against that same floor
 * with the tolerance applied — did the thing we are about to sign keep the promise.
 * Either can fail without the other.
 */
export async function prepareSwap(
  params: PrepareSwapParams,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const { result, routeSummary } = await requestRoute(
    params.symbol,
    params.usdcIn,
    options,
  );

  if (result.kind === "no-liquidity") {
    return { kind: "refused", detail: `${NO_ROUTE_DETAIL}: ${result.detail}` };
  }

  if (result.kind === "failed") {
    return { kind: "failed", detail: result.detail };
  }

  if (routeSummary === null) {
    return {
      kind: "failed",
      detail: `${ROUTE_SUMMARY_ABSENT_DETAIL}: quote carried no routeSummary to build from`,
    };
  }

  if (result.quote.unitsOut < params.minAmountOut) {
    return {
      kind: "refused",
      detail: `${PRICE_MOVED_DETAIL}: route now returns ${result.quote.unitsOut}, the quote shown was floored at ${params.minAmountOut}`,
    };
  }

  return buildSwap(
    {
      quote: result.quote,
      routeSummary,
      sender: params.sender,
      minAmountOut: params.minAmountOut,
      slippageBps: params.slippageBps,
    },
    options,
  );
}

/**
 * The build response, as far as we read it.
 *
 * Every field `unknown`, deliberately: this is a wire type, so declaring
 * `amountIn: string` here would be asserting something about a third party's JSON
 * that only the guards below can actually establish.
 *
 * `data.data` is the calldata — an unfortunate name, and KyberSwap's, not ours.
 */
type BuildEnvelope = {
  code?: unknown;
  message?: unknown;
  data?: {
    amountIn?: unknown;
    amountOut?: unknown;
    gas?: unknown;
    data?: unknown;
    routerAddress?: unknown;
    transactionValue?: unknown;
  };
};

/** What the guards check the response against. All of it known before the call. */
type BuildContext = {
  symbol: QuotableSymbol;
  /** The quote's `usdcIn`. The build must state this back. */
  amountIn: bigint;
  /** Token units: the floor under the quote the user was shown. */
  floor: bigint;
  /** Already checked by {@link isSlippageBps}. */
  slippageBps: number;
  deadline: number;
  expiresAt: number;
};

/**
 * Every guard, in order, against one response body. Pure.
 *
 * ORDER IS DELIBERATE. The router goes first because it is the only field whose
 * being wrong means something other than a bad response: it is the address the
 * user's USDC allowance names, so a mismatch there is the failure mode worth
 * finding before anything else in the body is read as meaningful. After that the
 * cheap identity check (`amountIn`), then the two value checks, then the shape
 * checks — narrowest question first, so a detail names the most specific thing
 * that is wrong rather than the first thing to trip.
 */
function interpretBuild(body: unknown, ctx: BuildContext): BuildResult {
  const envelope = (
    typeof body === "object" && body !== null ? body : {}
  ) as BuildEnvelope;
  const message = typeof envelope.message === "string" ? envelope.message : "";
  const code = typeof envelope.code === "number" ? envelope.code : null;

  // An aggregator that says no is not a disagreement with us; it is an answer we
  // could not use. `failed`, so the panel offers a retry.
  if (code !== null && code !== 0) {
    return {
      kind: "failed",
      detail: message === "" ? `aggregator returned code ${code}` : message,
    };
  }

  const data = envelope.data;
  if (typeof data !== "object" || data === null) {
    return {
      kind: "failed",
      detail: message === "" ? "response carried no data object" : message,
    };
  }

  /*
   * GUARD 1 — the router, against the pin.
   *
   * `sameAddress` and the two detail constants come from `lib/quote.ts` so that the
   * quote path and the build path ask this question exactly one way. Absence fails
   * closed alongside mismatch, for the reason `interpret` gives at length: a
   * response that names no router is a response whose route we cannot tie to the
   * address we pinned, and here that address is about to be handed calldata.
   */
  const echoedRouter =
    typeof data.routerAddress === "string" ? data.routerAddress : null;

  if (echoedRouter === null) {
    return {
      kind: "refused",
      detail: `${ROUTER_ABSENT_DETAIL}: build named no router, expected ${KYBERSWAP_ROUTER_ADDRESS}`,
    };
  }

  if (!sameAddress(echoedRouter, KYBERSWAP_ROUTER_ADDRESS)) {
    return {
      kind: "refused",
      detail: `${ROUTER_MISMATCH_DETAIL}: build named ${echoedRouter}, pinned ${KYBERSWAP_ROUTER_ADDRESS}`,
    };
  }

  /*
   * GUARD 2 — `amountIn`, stated back exactly.
   *
   * Stricter than the quote path, which tolerates the field being absent. There it
   * is an echo of a query parameter; here it is a statement about how much USDC the
   * calldata will pull from the user's account, and "it did not say" is not a thing
   * we can sign over.
   */
  const statedIn = toBigInt(data.amountIn);
  if (statedIn === null || statedIn !== ctx.amountIn) {
    return {
      kind: "refused",
      detail: `${AMOUNT_IN_MISMATCH_DETAIL}: build states ${String(data.amountIn)}, quoted ${ctx.amountIn}`,
    };
  }

  // GUARD 3 — `amountOut` is a positive integer. Zero out is a route that does
  // nothing, and unreadable is a field we will not scale into a share count.
  const amountOut = toBigInt(data.amountOut);
  if (amountOut === null || amountOut <= 0n) {
    return {
      kind: "refused",
      detail: `${AMOUNT_OUT_UNREADABLE_DETAIL}: ${String(data.amountOut)}`,
    };
  }

  /*
   * GUARD 4 — the built route is not materially worse than the quote shown.
   *
   * The comparison is against the floor *with the tolerance applied*, and it has to
   * be. Requiring the built output to clear the floor outright would refuse every
   * adverse tick, which is exactly what a tolerance exists to absorb: the user
   * already agreed to settle up to `slippageBps` below the quote. What this catches
   * is an encoded route that comes back worse than that agreement — a different
   * trade wearing the quote's clothes.
   */
  const tolerated = lessBps(ctx.floor, ctx.slippageBps);
  if (amountOut < tolerated) {
    return {
      kind: "refused",
      detail: `${AMOUNT_OUT_SHORTFALL_DETAIL}: build returns ${amountOut}, floor ${ctx.floor} less ${ctx.slippageBps}bps is ${tolerated}`,
    };
  }

  /*
   * GUARD 5 — no ETH rides along.
   *
   * We are spending USDC through an allowance. A non-zero `transactionValue` means
   * the request was read as an ETH-in swap, and signing it would send the wallet's
   * ETH balance somewhere on top of the swap. Refused, not corrected: if the value
   * is wrong the calldata was built for a different transaction than we asked for,
   * and zeroing the field would just hide that.
   */
  const value = toBigInt(data.transactionValue);
  if (value === null || value !== 0n) {
    return {
      kind: "refused",
      detail: `${TRANSACTION_VALUE_DETAIL}: ${String(data.transactionValue)}`,
    };
  }

  // GUARD 6 — the calldata is bytes. Shape only; see the module note on why this
  // is the last thing we ask about it.
  if (!isCalldata(data.data)) {
    return {
      kind: "refused",
      detail: `${CALLDATA_MALFORMED_DETAIL}: ${describeCalldata(data.data)}`,
    };
  }

  return {
    kind: "transaction",
    transaction: {
      symbol: ctx.symbol,
      to: KYBERSWAP_ROUTER_ADDRESS,
      data: data.data,
      value: "0",
      amountIn: statedIn,
      amountOut,
      minAmountOut: lessBps(amountOut, ctx.slippageBps),
      slippageBps: ctx.slippageBps,
      gas: toBigInt(data.gas),
      deadline: ctx.deadline,
      expiresAt: ctx.expiresAt,
    },
  };
}

/** True when a non-success result carries this code. */
function hasCode(result: BuildResult, code: string): boolean {
  return result.kind !== "transaction" && result.detail.startsWith(`${code}:`);
}

/**
 * The refusal that means "quote again", not "try again".
 *
 * Exported so `/api/build` can answer it with its own status: everything else that
 * comes back refused is a disagreement worth a log line, and this one is a price
 * that moved while a person was reading. The panel's response to it is to re-quote
 * and show the new number, which is a different thing from a retry.
 */
export function isPriceMoved(result: BuildResult): boolean {
  return hasCode(result, PRICE_MOVED_DETAIL);
}

/**
 * The refusal that means the market, not the request.
 *
 * A token can pass the tradeability probe at one size and have no route at another,
 * and a user who typed a larger amount should be told that rather than shown a
 * generic failure.
 */
export function isNoRoute(result: BuildResult): boolean {
  return hasCode(result, NO_ROUTE_DETAIL);
}

/**
 * Calldata, by shape alone.
 *
 * A type predicate rather than a bare `test`, so the success case assigns `data`
 * without a cast — the narrowing is the check, which is the only place the two can
 * be kept honest with each other.
 */
function isCalldata(value: unknown): value is Hex {
  return typeof value === "string" && CALLDATA_SHAPE.test(value);
}

/**
 * A calldata field described, never dumped.
 *
 * Real calldata for a multi-hop route runs to kilobytes, and a refusal detail ends
 * up in a server log. Type, length and the first four bytes are what a person
 * debugging this actually reads — the selector plus enough to tell truncation from
 * garbage.
 */
function describeCalldata(value: unknown): string {
  if (typeof value !== "string") return `not a string (${typeof value})`;
  if (value.length === 0) return "empty string";

  return `${value.length} chars starting ${value.slice(0, 10)}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Undefined where `AbortSignal.timeout` is missing — same as the quote path. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined;
}

/* ------------------------------------------------------------------ *
 * The request seam.
 *
 * `/api/build` is the only caller of the two functions below, and they live
 * here rather than in the route for the reason `parseQuoteParams` and
 * `toQuoteWire` live in `lib/quote.ts`: a route file cannot be exercised
 * without `next/server`, and this is the half with the decisions in it. The
 * route stays a shell — parse, forward, choose a status.
 * ------------------------------------------------------------------ */

/**
 * Longest run of digits `minAmountOut` is even looked at.
 *
 * Same reasoning as the cap inside `parseQuoteParams`, and the same number: this
 * is an unauthenticated endpoint, `BigInt()` conversion cost grows faster than its
 * input, so the length check goes before the conversion. Twenty-four digits is far
 * past any share count these tokens' 8 decimals can express.
 */
const MAX_UNITS_DIGITS = 24;

export type BuildParams =
  | {
      ok: true;
      symbol: QuotableSymbol;
      usdcIn: bigint;
      /** Canonical EIP-55. Becomes `recipient` too, inside {@link buildSwap}. */
      sender: Address;
      minAmountOut: bigint;
    }
  /** Reason to hand back verbatim as a 400. Names the field at fault. */
  | { ok: false; reason: string };

/**
 * Validates the JSON body `/api/build` was posted.
 *
 * Pure, and the whole input surface of the endpoint. Four fields, and no fifth:
 * `recipient` is deliberately not among them — {@link buildSwap} sets it to the
 * sender, so there is no request that routes one wallet's output to another.
 *
 * `symbol` and `amountIn` go through `parseQuoteParams` rather than a second copy
 * of the registry lookup and the amount band. A non-string is normalised to a value
 * that validator already rejects, which keeps one message for one mistake — a
 * number, a null and a decimal are all "not an integer number of base units", and
 * that sentence should exist once.
 *
 * `minAmountOut` must be a positive integer string. Zero is refused rather than
 * read as "no floor": a request with no floor is one we would build whatever came
 * back for, which is precisely the trade the user did not agree to. It arrives as a
 * string because that is how `unitsOut` leaves `/api/quote` — a JSON number would
 * quietly lose precision on a value that decides whether a swap reverts.
 */
export function parseBuildBody(body: unknown): BuildParams {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "body must be a JSON object" };
  }

  const fields = body as Record<string, unknown>;

  const params = new URLSearchParams();
  params.set("symbol", typeof fields.symbol === "string" ? fields.symbol : "");
  params.set(
    "amountIn",
    typeof fields.amountIn === "string" ? fields.amountIn : "",
  );

  const quoted = parseQuoteParams(params);
  if (!quoted.ok) return quoted;

  // `parseAddress`, not `isValidTokenAddress`: a wallet is not a `0xb2…`
  // precompile. It also canonicalises, so `sender` and `recipient` go out in one
  // spelling, and it rejects a mixed-case address whose checksum does not hold —
  // the one transcription check an address carries, and this is the address every
  // share bought here is delivered to.
  const sender = parseAddress(fields.sender);
  if (sender === null) {
    return {
      ok: false,
      reason:
        "sender must be a wallet address, checksummed if it carries mixed case",
    };
  }

  const stated = fields.minAmountOut;
  const minAmountOut =
    typeof stated === "string" && stated.length <= MAX_UNITS_DIGITS
      ? toBigInt(stated)
      : null;

  if (minAmountOut === null || minAmountOut <= 0n) {
    return {
      ok: false,
      reason:
        "minAmountOut must be a positive integer number of token base units",
    };
  }

  return {
    ok: true,
    symbol: quoted.symbol,
    usdcIn: quoted.usdcIn,
    sender,
    minAmountOut,
  };
}

/**
 * The transaction as it crosses to the browser.
 *
 * `bigint` does not survive JSON, and these are exact amounts a wallet will move,
 * so they travel as decimal strings rather than being rounded into a number.
 *
 * The fields `SwapTransaction` carries and this does not are the ones the caller
 * either sent itself (`symbol`, `amountIn`) or cannot change by knowing
 * (`slippageBps` and `deadline` are already encoded in the calldata). What crosses
 * is what the panel has to show and what a wallet has to be handed.
 */
export type SwapTransactionWire = {
  kind: "transaction";
  /** The pinned router — our constant, not the address the response echoed. */
  to: string;
  data: Hex;
  value: "0";
  /** Token base units. */
  amountOut: string;
  /** Token base units, derived by us from `amountOut` and the tolerance. */
  minAmountOut: string;
  /** Gas units the aggregator estimated, or null when it did not say. */
  gas: string | null;
  /** Unix ms: the quote's expiry, so the panel counts one clock. */
  expiresAt: number;
};

export function toSwapWire(
  transaction: SwapTransaction,
): SwapTransactionWire {
  return {
    kind: "transaction",
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    amountOut: transaction.amountOut.toString(),
    minAmountOut: transaction.minAmountOut.toString(),
    gas: transaction.gas === null ? null : transaction.gas.toString(),
    expiresAt: transaction.expiresAt,
  };
}

/** What the browser has after reading a build payload. */
export type ParsedSwap = {
  /** The pin, as a checked-and-then-discarded echo. See {@link parseSwapWire}. */
  to: string;
  data: Hex;
  value: "0";
  amountOut: bigint;
  minAmountOut: bigint;
  gas: bigint | null;
  expiresAt: number;
};

/**
 * The three ways a build payload can land, and only one of them is a transaction.
 *
 * `unsafe` and `unreadable` are the same distinction `BuildResult` draws between
 * `refused` and `failed`, restated at the second boundary: `unsafe` means the
 * payload was legible and disagreed with something we pinned, so retrying it is
 * pointless and continuing is worse. `unreadable` is a payload we could not use,
 * which a retry might fix.
 */
export type SwapWireResult =
  | { kind: "transaction"; transaction: ParsedSwap }
  | { kind: "unsafe"; detail: string }
  | { kind: "unreadable"; detail: string };

/**
 * The last checks before a wallet is asked for a signature.
 *
 * THE BROWSER IS WHERE THIS VALUE IS USED, SO THE BROWSER IS WHERE IT IS CHECKED.
 * `/api/build` already set `to` to {@link KYBERSWAP_ROUTER_ADDRESS} and `value` to
 * `"0"` — this is not a substitute for that, it is the same guarantee restated where
 * it matters. Between the route handler and `sendTransaction` sit a network hop, a
 * service worker that may be serving a cached bundle, an asset host, and whatever
 * else is on the machine. A tampered `to` is a signature that hands a user's USDC
 * allowance to an attacker's contract; a non-zero `value` is a swap that also drains
 * their ETH. Both are cheap to refuse and unrecoverable to send.
 *
 * A pure function, in `lib`, because `npm test` covers it there. Written as a parse
 * rather than a cast for the reason `parseQuoteWire` is: `body as SwapTransactionWire`
 * would assert `value` is `"0"` on data that had not been looked at yet, and the type
 * would then say the check had happened.
 *
 * `minAmountOut` is checked against `amountOut` rather than taken on trust, so a
 * payload cannot claim a floor above the output it is a floor under.
 *
 * It is deliberately *not* compared against the floor the browser sent. The server
 * builds a fresh route and derives the encoded floor from that route's `amountOut`
 * (see {@link buildSwap}'s GUARD 4 and `interpretBuild`), so an equal comparison
 * would refuse every ordinary adverse tick. What protects the user against a route
 * that came back materially worse is GUARD 4 itself, server-side, against the floor
 * the browser sent — and the encoded `minAmountOut` reaching the panel, so the
 * number on screen is the number the calldata enforces.
 */
export function parseSwapWire(body: unknown): SwapWireResult {
  if (typeof body !== "object" || body === null) {
    return { kind: "unreadable", detail: "build payload was not an object" };
  }

  const value = body as Record<string, unknown>;

  if (value.kind !== "transaction") {
    return { kind: "unreadable", detail: "build payload was not a transaction" };
  }

  // Read into locals first, so every check below narrows a reference rather than a
  // property of an object nothing has vouched for. Same shape as `parseQuoteWire`.
  const to = value.to;
  const sent = value.value;
  const data = value.data;

  // The router first, and as a refusal rather than an unreadable payload: a build
  // naming a different `to` is not a request worth repeating.
  if (typeof to !== "string") {
    return { kind: "unsafe", detail: ROUTER_ABSENT_DETAIL };
  }

  if (!sameAddress(to, KYBERSWAP_ROUTER_ADDRESS)) {
    return {
      kind: "unsafe",
      detail: `${ROUTER_MISMATCH_DETAIL}: payload named ${to}, pinned ${KYBERSWAP_ROUTER_ADDRESS}`,
    };
  }

  // Compared to the string, not coerced to a number: `0`, `"0x0"` and `""` are all
  // falsy, and a swap that carries ETH has to fail this rather than pass it.
  if (sent !== "0") {
    return {
      kind: "unsafe",
      detail: `${TRANSACTION_VALUE_DETAIL}: payload said ${String(sent)}`,
    };
  }

  if (!isCalldata(data)) {
    return {
      kind: "unsafe",
      detail: `${CALLDATA_MALFORMED_DETAIL}: ${describeCalldata(data)}`,
    };
  }

  const amountOut = toBigInt(value.amountOut);
  const minAmountOut = toBigInt(value.minAmountOut);
  const expiresAt = value.expiresAt;

  if (
    amountOut === null ||
    minAmountOut === null ||
    amountOut <= 0n ||
    minAmountOut <= 0n ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt)
  ) {
    return { kind: "unreadable", detail: "build payload was incomplete" };
  }

  if (minAmountOut > amountOut) {
    return {
      kind: "unsafe",
      detail: `${AMOUNT_OUT_SHORTFALL_DETAIL}: floor ${minAmountOut} above the ${amountOut} quoted`,
    };
  }

  return {
    kind: "transaction",
    transaction: {
      // The pinned constant, not the string just checked against it. Identical bar
      // casing, and this way the value a wallet is handed came from the repo.
      to: KYBERSWAP_ROUTER_ADDRESS,
      data,
      value: "0",
      amountOut,
      minAmountOut,
      gas: toBigInt(value.gas),
      expiresAt,
    },
  };
}
