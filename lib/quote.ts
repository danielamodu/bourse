import { assertValidTokenAddress } from "@/lib/address";
import { ceilBps, scaleBigInt } from "@/lib/price";
import {
  TOKEN_ADDRESSES,
  TOKEN_DECIMALS,
  USDC_ADDRESS,
  USDC_DECIMALS,
  isQuotableSymbol,
  isStockSymbol,
  type QuotableSymbol,
} from "@/lib/tokens";

/**
 * KyberSwap aggregator quotes. USDC in, tokenized stock out.
 *
 * Read-only. This module asks what a trade would cost and nothing else — no
 * approval, no signature, no submission. The router the response names is
 * checked against an address pinned here rather than carried through on trust —
 * see {@link KYBERSWAP_ROUTER_ADDRESS}.
 *
 * WHY KYBERSWAP: 0x is compliance-blocked for tokenized equities and answers a
 * quote request for these tokens with `BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE`. That
 * is policy on their side, not a parameter we got wrong, so there is nothing to
 * debug and no fallback to reinstate.
 *
 * WHY THREE OUTCOMES: `QuoteResult` separates "this token cannot be bought right
 * now" from "our request did not work". They are different sentences to someone
 * about to spend naira, and collapsing them would let a failed fetch tell a user
 * a market does not exist. Where the aggregator's answer is ambiguous the
 * classification lands on `failed`, the reversible one — "try again" is honest
 * when we do not know, while "no liquidity" is a claim about the market.
 *
 * Callers pass USDC base units. Naira never enters this file: the rate lives in
 * the browser, so `hooks/useQuote.ts` converts in and back out again, the same
 * split `lib/price.ts` uses for reference prices.
 */

/**
 * The routes endpoint. Exported so `verify/quote.verify.ts` checks the same URL
 * the app calls rather than a second copy of it that can drift.
 */
export const KYBERSWAP_ROUTES_URL =
  "https://aggregator-api.kyberswap.com/base/api/v1/routes";

/**
 * The router every KyberSwap route on Base executes through, pinned.
 *
 * WHY THIS IS A CONSTANT AND NOT A FIELD WE READ. In Part B this address is the
 * spender of a user's USDC allowance. An allowance is granted to whatever address
 * the approval names, so if the spender came from the quote response, then
 * whoever could shape that response — a compromised endpoint, a hijacked DNS
 * answer, a proxy on a Lagos mobile network — could name a contract of their own
 * and receive an allowance over the user's USDC. That is the worst outcome this
 * app can produce. It is worse than a bad price, because a bad price costs one
 * ticket and is visible in the panel, while an allowance is invisible after the
 * fact, survives the session, and keeps draining every USDC the wallet ever holds.
 *
 * So the response's own `routerAddress` is treated as an echo to check, exactly
 * like `tokenIn`, `tokenOut` and `amountIn`: it has to match this, or there is no
 * quote. Comparison is case-insensitive because EIP-55 checksum casing is
 * cosmetic and KyberSwap returns this one lowercase.
 *
 * PROVENANCE: observed by `npm run verify:quote` on 2026-09-04 as the router for
 * all four tradeable tokens, and asserted to have bytecode by
 * `npm run verify:chain`. It is an ordinary contract, not a B20 precompile, so
 * `isValidTokenAddress` does not and must not apply to it.
 */
export const KYBERSWAP_ROUTER_ADDRESS =
  "0x61354c7f0345dfb519b79dbddca059db53f237b5";

/**
 * Detail strings for the two ways the router check can fail. Distinct constants
 * so a log line, a test, or a later alert can match the case exactly instead of
 * pattern-matching prose.
 */
export const ROUTER_MISMATCH_DETAIL = "router-address-mismatch";
export const ROUTER_ABSENT_DETAIL = "router-address-absent";

/**
 * Bourse's own fee, in basis points. Zero.
 *
 * The plumbing exists at zero on purpose. `bourseFeeParams` below only attaches
 * KyberSwap's fee parameters when this is above zero, so switching a fee on is a
 * one-line change to a request shape that is already tested, rather than a new
 * integration written under time pressure. And the panel renders a Bourse fee
 * line at every value including this one: a user who has always seen "None" on
 * that line will see the day it changes, whereas a line that appears for the
 * first time alongside a number reads as a charge that was hidden until now.
 *
 * Typed `number` rather than left as the literal `0` so both branches of the fee
 * plumbing stay live code that the compiler checks.
 */
export const BOURSE_FEE_BPS: number = 0;

/** How long a quote is presented as current. Also the refetch interval. */
export const QUOTE_TTL_MS = 30_000;

/**
 * Most a route may cost before we stop calling a token buyable, in basis points.
 *
 * 3% is deliberately loose. Measured against real routes it is not close: the
 * four tradeable tokens came back between 58 and 105bps at a ₦50,000 ticket, and
 * the same tokens quoted the same rate to five significant figures at $30 and at
 * $500 — so almost none of that cost is size-dependent slippage. What the budget
 * actually catches is a token whose only route is priced absurdly, which is the
 * thing that separates unbuyable from merely thin.
 *
 * Still measured at the user's real order size, so a large order can fail the
 * budget on a token a small order passes on. That is correct behaviour, not a bug
 * to smooth over.
 */
export const EXECUTION_COST_BUDGET_BPS = 300;

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * The band of order sizes we will ask about, in USDC base units: $1 to $1,000,000.
 *
 * Authored here rather than in the route so the browser and the server agree on
 * it. The hook needs the same numbers to tell someone their amount is too small
 * *before* spending a round trip on a request the route would reject — a 400
 * rendered as "we could not get a price" would be a lie, since nothing failed.
 *
 * Below $1 a quote is noise and the impact figure means nothing. The ceiling is
 * far above any Bourse ticket and exists so the band is closed at both ends.
 */
export const MIN_QUOTE_USDC_UNITS = 1_000_000n;
export const MAX_QUOTE_USDC_UNITS = 1_000_000_000_000n;

/**
 * Identifies Bourse to KyberSwap for rate-limit attribution. Not a credential
 * and not a secret; it still stays server-side because every quote goes out
 * through our own route rather than from the browser.
 *
 * Read inside the request rather than at module scope so that when a bundler
 * tree-shakes `requestQuote` out of the client build, the `process.env` reference
 * goes with it.
 */
function clientId(): string {
  return process.env.KYBERSWAP_CLIENT_ID ?? "bourse";
}

/**
 * Where a Bourse fee would be paid, from the environment.
 *
 * No address that receives money goes in the repo. It is deployment
 * configuration, and an address in source is an address nobody machine-verified —
 * which is the rule the whole registry is built on. Read inside the request for
 * the same reason as {@link clientId}.
 */
function feeReceiver(): string | null {
  const value = process.env.BOURSE_FEE_RECEIVER;
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export type FeeParams =
  /** No fee to charge, so nothing is attached to the request. */
  | { kind: "none" }
  | { kind: "params"; params: Record<string, string> }
  /** A fee is configured with nowhere to send it. Refuse rather than guess. */
  | { kind: "misconfigured"; detail: string };

/**
 * KyberSwap's fee parameters, or nothing.
 *
 * Pure and separate from `requestQuote` so both branches are covered offline —
 * the shape of a request Bourse has never sent in anger is exactly the thing that
 * should be pinned by a test rather than discovered on the day a fee is switched
 * on.
 *
 * At zero the parameters are omitted entirely rather than sent as `feeAmount=0`.
 * A fee of zero to no receiver is not a fee, and sending it invites the
 * aggregator to reject the request or, worse, to quote one with a fee routed
 * nowhere.
 *
 * `chargeFeeBy: "currency_in"` takes the fee from the USDC going in, so it sits
 * inside the amount the user already agreed to pay instead of quietly reducing
 * the share count they were shown. That is what lets the panel state one total
 * and one number of shares.
 */
export function bourseFeeParams(bps: number, receiver: string | null): FeeParams {
  if (!Number.isFinite(bps) || bps <= 0) return { kind: "none" };

  if (!Number.isInteger(bps)) {
    return {
      kind: "misconfigured",
      detail: `BOURSE_FEE_BPS must be a whole number of basis points, got ${bps}`,
    };
  }

  if (receiver === null) {
    return {
      kind: "misconfigured",
      detail:
        "BOURSE_FEE_BPS is above zero but BOURSE_FEE_RECEIVER is not set, so the fee has nowhere to go",
    };
  }

  return {
    kind: "params",
    params: {
      feeAmount: String(bps),
      isInBps: "true",
      chargeFeeBy: "currency_in",
      feeReceiver: receiver,
    },
  };
}

/** A priced route. Every figure here is an estimate, and the UI says so. */
export type Quote = {
  symbol: QuotableSymbol;
  /** USDC spent, in USDC base units. Exact. */
  usdcIn: bigint;
  /** The same amount as dollars, for display and per-share arithmetic. */
  usdIn: number;
  /** Token units received, in the token's own decimals. As quoted. */
  unitsOut: bigint;
  /** Units scaled by the token's `decimals()`. An estimate — the UI labels it. */
  shares: number;
  /** What a share costs on this route: `usdIn / shares`. */
  usdPerShare: number;
  /**
   * What crossing the market costs, in basis points of the amount paid: the gap
   * between the dollars going in and the dollars of stock coming out.
   *
   * NOT price impact, despite what an aggregator field name might suggest. It
   * bundles the pool fee, the bid-ask spread and any disagreement between the
   * two price lookups the aggregator used to value the legs. Size-dependent
   * slippage is a small part of it and often none of it: the same tokens quoted
   * the same rate to five significant figures at $30 and at $500 while this
   * figure sat between 58 and 105bps. The UI calls it market spread for that
   * reason.
   *
   * Null when the aggregator did not price both legs, which reads as unknown and
   * never as zero.
   */
  executionCostBps: number | null;
  /** Gas the aggregator estimates for this route, in USD. Null when absent. */
  gasUsd: number | null;
  /**
   * The router this route executes through. Never null on a quote that exists:
   * a response naming anything but {@link KYBERSWAP_ROUTER_ADDRESS}, or naming
   * nothing, is a `failed` result rather than a quote. The type says so, so that
   * Part B cannot be written against a router this module never checked.
   */
  routerAddress: string;
  receivedAtMs: number;
  /** `receivedAtMs + QUOTE_TTL_MS`. Past this the panel stops presenting it. */
  expiresAtMs: number;
};

export type QuoteResult =
  | { kind: "quote"; quote: Quote }
  /** The aggregator answered and has no route at this size. */
  | { kind: "no-liquidity"; detail: string }
  /** We could not get an answer we trust. Retryable. */
  | { kind: "failed"; detail: string };

export type RequestQuoteOptions = {
  /** Injected in tests so the suite never touches the network. */
  fetchImpl?: typeof fetch;
  /** Injected so expiry is assertable. */
  nowMs?: number;
};

/**
 * Asks KyberSwap what `usdcIn` buys of one stock token.
 *
 * Never throws: a thrown error at a quote boundary would surface to a user as a
 * blank panel, so every failure comes back as `failed` with the reason attached
 * for the log.
 */
export async function requestQuote(
  symbol: QuotableSymbol,
  usdcIn: bigint,
  options: RequestQuoteOptions = {},
): Promise<QuoteResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now();

  if (usdcIn <= 0n) {
    return { kind: "failed", detail: `amountIn must be positive, got ${usdcIn}` };
  }

  // The registry addresses are shape-asserted at import, so this is belt and
  // braces — but a quote is one of the boundaries CLAUDE.md names explicitly,
  // and the cost of re-checking is nothing against routing someone at a
  // counterfeit contract.
  const tokenAddress = assertValidTokenAddress(
    TOKEN_ADDRESSES[symbol],
    `quote tokenOut for ${symbol}`,
  );
  const tokenDecimals = TOKEN_DECIMALS[symbol];

  const url = new URL(KYBERSWAP_ROUTES_URL);
  url.searchParams.set("tokenIn", USDC_ADDRESS);
  url.searchParams.set("tokenOut", tokenAddress);
  url.searchParams.set("amountIn", usdcIn.toString());
  // Without this the response carries no gas estimate, and estimated gas is one
  // of the figures the trade panel is required to show.
  url.searchParams.set("gasInclude", "true");

  const fee = bourseFeeParams(BOURSE_FEE_BPS, feeReceiver());
  if (fee.kind === "misconfigured") {
    // Refused before the request goes out. A fee we cannot deliver is a
    // deployment mistake, and quoting around it would hide it until someone
    // reconciled receipts that never arrived.
    return { kind: "failed", detail: fee.detail };
  }
  if (fee.kind === "params") {
    for (const [key, value] of Object.entries(fee.params)) {
      url.searchParams.set(key, value);
    }
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", "x-client-id": clientId() },
      cache: "no-store",
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    return { kind: "failed", detail: `request threw: ${describe(cause)}` };
  }

  // 404 is the one status that means the market rather than the request: the
  // aggregator was reached and had nothing to offer.
  if (response.status === 404) {
    return { kind: "no-liquidity", detail: "aggregator returned 404" };
  }

  if (!response.ok) {
    return { kind: "failed", detail: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return { kind: "failed", detail: `malformed JSON: ${describe(cause)}` };
  }

  return interpret(body, { symbol, usdcIn, tokenAddress, tokenDecimals, nowMs });
}

type InterpretContext = {
  symbol: QuotableSymbol;
  usdcIn: bigint;
  tokenAddress: string;
  tokenDecimals: number;
  nowMs: number;
};

/** `code: 0` plus `data.routeSummary` on success; a code and a message otherwise. */
type Envelope = {
  code?: unknown;
  message?: unknown;
  data?: { routeSummary?: unknown; routerAddress?: unknown };
};

type RouteSummary = {
  tokenIn?: unknown;
  amountIn?: unknown;
  amountInUsd?: unknown;
  tokenOut?: unknown;
  amountOut?: unknown;
  amountOutUsd?: unknown;
  gasUsd?: unknown;
  routerAddress?: unknown;
};

/**
 * Messages that mean the market, not the request.
 *
 * Narrow on purpose. Anything unrecognised falls through to `failed`, so a new
 * upstream error string produces "we could not get a price, try again" rather
 * than a false claim that a stock cannot be bought. Widen this only against a
 * message seen in `verify/quote.verify.ts` output.
 */
const NO_ROUTE_MESSAGE =
  /no route|route not found|cannot find route|insufficient liquidity|no pool/i;

function classifyRejection(message: string, fallback: string): QuoteResult {
  if (NO_ROUTE_MESSAGE.test(message)) {
    return { kind: "no-liquidity", detail: message };
  }
  return { kind: "failed", detail: message === "" ? fallback : message };
}

function interpret(body: unknown, ctx: InterpretContext): QuoteResult {
  const envelope = (
    typeof body === "object" && body !== null ? body : {}
  ) as Envelope;
  const message = typeof envelope.message === "string" ? envelope.message : "";
  const code = typeof envelope.code === "number" ? envelope.code : null;

  if (code !== null && code !== 0) {
    return classifyRejection(message, `aggregator returned code ${code}`);
  }

  const raw: unknown = envelope.data?.routeSummary;
  if (typeof raw !== "object" || raw === null) {
    return classifyRejection(message, "response carried no routeSummary");
  }
  const summary = raw as RouteSummary;

  /*
   * Guard the echo before trusting a single number out of it.
   *
   * A response that priced a different pair than we asked about is not a quote we
   * can show. This is the counterfeit failure mode from the other direction: the
   * address we send is shape-checked, so what is left to check is that the answer
   * is about the address we sent.
   */
  if (!sameAddress(summary.tokenOut, ctx.tokenAddress)) {
    return {
      kind: "failed",
      detail: `tokenOut echoed as ${String(summary.tokenOut)}, asked for ${ctx.tokenAddress}`,
    };
  }

  if (!sameAddress(summary.tokenIn, USDC_ADDRESS)) {
    return {
      kind: "failed",
      detail: `tokenIn echoed as ${String(summary.tokenIn)}, sent USDC`,
    };
  }

  const echoedIn = toBigInt(summary.amountIn);
  if (echoedIn !== null && echoedIn !== ctx.usdcIn) {
    return {
      kind: "failed",
      detail: `amountIn echoed as ${echoedIn}, sent ${ctx.usdcIn}`,
    };
  }

  const unitsOut = toBigInt(summary.amountOut);
  if (unitsOut === null) {
    return {
      kind: "failed",
      detail: `amountOut unreadable: ${String(summary.amountOut)}`,
    };
  }

  // A route that hands back nothing is a market answer, not a broken request.
  if (unitsOut <= 0n) {
    return { kind: "no-liquidity", detail: "route priced at zero out" };
  }

  const shares = scaleBigInt(unitsOut, ctx.tokenDecimals);
  const usdIn = scaleBigInt(ctx.usdcIn, USDC_DECIMALS);

  if (!Number.isFinite(shares) || shares <= 0) {
    return {
      kind: "failed",
      detail: `could not scale ${unitsOut} at ${ctx.tokenDecimals} decimals`,
    };
  }

  if (!Number.isFinite(usdIn) || usdIn <= 0) {
    return {
      kind: "failed",
      detail: `could not scale ${ctx.usdcIn} at ${USDC_DECIMALS} decimals`,
    };
  }

  /*
   * The fourth echo guard, and the one with the most at stake.
   *
   * `tokenIn`, `tokenOut` and `amountIn` above check that the answer is about the
   * question. This checks the router the route would execute through, because that
   * address becomes the spender of a USDC allowance in Part B. A response is not
   * allowed to name its own spender — see {@link KYBERSWAP_ROUTER_ADDRESS} for why
   * that is the worst thing this app could get wrong.
   *
   * Absence fails closed alongside mismatch. It has to: a response that stopped
   * naming a router is a response whose route we can no longer tie to the address
   * we pinned, and "we could not get a price, try again" is the honest outcome of
   * that. The cost of the choice is real — if KyberSwap ever drops the field,
   * every quote fails until we notice — and `verify:quote` is what would surface
   * it, deliberately, instead of a user's allowance doing so.
   */
  const echoedRouter =
    typeof summary.routerAddress === "string"
      ? summary.routerAddress
      : typeof envelope.data?.routerAddress === "string"
        ? envelope.data.routerAddress
        : null;

  if (echoedRouter === null) {
    return {
      kind: "failed",
      detail: `${ROUTER_ABSENT_DETAIL}: response named no router, expected ${KYBERSWAP_ROUTER_ADDRESS}`,
    };
  }

  if (!sameAddress(echoedRouter, KYBERSWAP_ROUTER_ADDRESS)) {
    return {
      kind: "failed",
      detail: `${ROUTER_MISMATCH_DETAIL}: response named ${echoedRouter}, pinned ${KYBERSWAP_ROUTER_ADDRESS}`,
    };
  }

  return {
    kind: "quote",
    quote: {
      symbol: ctx.symbol,
      usdcIn: ctx.usdcIn,
      usdIn,
      unitsOut,
      shares,
      usdPerShare: usdIn / shares,
      executionCostBps: executionCostBps(
        toFiniteNumber(summary.amountInUsd),
        toFiniteNumber(summary.amountOutUsd),
      ),
      gasUsd: toFiniteNumber(summary.gasUsd),
      // The echoed value, now known to be the pinned one bar casing. Kept as
      // received so a log line shows what the aggregator actually said.
      routerAddress: echoedRouter,
      receivedAtMs: ctx.nowMs,
      expiresAtMs: ctx.nowMs + QUOTE_TTL_MS,
    },
  };
}

/**
 * What crossing the market costs, in basis points, from the aggregator's own
 * valuation of both legs: `(usdIn - usdOut) / usdIn`.
 *
 * Named for what it measures. It is not price impact — it bundles the pool fee,
 * the spread and any disagreement between the two price lookups used to value the
 * legs, and on real routes almost none of it moves with order size. The panel
 * labels it market spread.
 *
 * Null rather than zero when either leg is unpriced: "we do not know what this
 * costs" and "it costs nothing" are different statements, and only one of them
 * should ever let a buy affordance render.
 *
 * Rounded up to a whole basis point rather than to the nearest one — the contract
 * is stated on {@link ceilBps}. `Math.round` reported half a basis point of cost
 * as none at all, which reads as a free route; a cost this function cannot state
 * precisely is stated high. Zero is therefore reserved for a route with no
 * measurable cost, and `formatCostBps` renders it as a threshold rather than as an
 * exact `0.00%`. On the four real routes that branch does not arise — they measure
 * 58 to 105bps — so it is the rare case, not the common one.
 *
 * A negative result is clamped to zero. It means the aggregator valued the output
 * slightly above the input, which is two independent price lookups disagreeing —
 * not a gain, and not something to display as one.
 */
export function executionCostBps(
  usdIn: number | null,
  usdOut: number | null,
): number | null {
  if (usdIn === null || usdOut === null) return null;
  if (!Number.isFinite(usdIn) || !Number.isFinite(usdOut)) return null;
  if (usdIn <= 0) return null;

  const bps = ceilBps(((usdIn - usdOut) / usdIn) * 10_000);
  return bps > 0 ? bps : 0;
}

/** True once a quote is past its expiry, or already at it. */
export function isQuoteExpired(quote: Quote, nowMs: number): boolean {
  return nowMs >= quote.expiresAtMs;
}

/** Whole milliseconds left on a quote, floored at zero. */
export function quoteMsRemaining(quote: Quote, nowMs: number): number {
  return Math.max(0, quote.expiresAtMs - nowMs);
}

/**
 * Naira to USDC base units.
 *
 * Rounds down: overstating what we send would quote a trade the user cannot
 * actually fund. Returns null for any input that cannot produce an honest amount,
 * including a rate we have not fetched yet.
 */
export function ngnToUsdcUnits(
  ngn: number,
  usdToNgnRate: number | null,
): bigint | null {
  if (!Number.isFinite(ngn) || ngn <= 0) return null;
  if (usdToNgnRate === null) return null;
  if (!Number.isFinite(usdToNgnRate) || usdToNgnRate <= 0) return null;

  const usd = ngn / usdToNgnRate;
  const units = Math.floor(usd * 10 ** USDC_DECIMALS);

  if (!Number.isFinite(units) || units <= 0) return null;
  return BigInt(units);
}

/**
 * Longest `amountIn` string `parseQuoteParams` will even look at.
 *
 * The band's ceiling is 13 digits, so 24 is far past anything real and still
 * short enough that `BigInt()` is never handed a multi-kilobyte run of digits to
 * convert before the band check can reject it — conversion cost grows faster than
 * the input, and this is an unauthenticated endpoint that forwards to a third
 * party under our client id. The cheap rejection goes first.
 */
const MAX_AMOUNT_IN_DIGITS = 24;

export type QuoteParams =
  | { ok: true; symbol: QuotableSymbol; usdcIn: bigint }
  /** Reason to hand back verbatim as a 400. Names the parameter at fault. */
  | { ok: false; reason: string };

/**
 * Validates the query string `/api/quote` was called with.
 *
 * Pure and here rather than in the route so it is covered by the offline suite —
 * the route itself cannot be exercised without `next/server`, and this is the part
 * with the decisions in it.
 *
 * `symbol` has to be one of the four we hold an address for; a stock we know but
 * cannot quote is rejected by name, because "MSFT is not quotable" and "ZZZZ is
 * not a stock" are different mistakes. `amountIn` is USDC base units as an
 * integer string, bounded at both ends by the band the hook checks against
 * before it ever sends a request.
 */
export function parseQuoteParams(params: URLSearchParams): QuoteParams {
  const symbol = params.get("symbol");
  if (symbol === null || !isStockSymbol(symbol)) {
    return { ok: false, reason: "symbol must be one of the listed stocks" };
  }
  if (!isQuotableSymbol(symbol)) {
    return {
      ok: false,
      reason: `${symbol} has no token address on Base, so it cannot be quoted`,
    };
  }

  const amountIn = params.get("amountIn");
  if (
    amountIn === null ||
    amountIn.length === 0 ||
    amountIn.length > MAX_AMOUNT_IN_DIGITS ||
    !/^\d+$/.test(amountIn)
  ) {
    // One message for every malformed shape: a negative, a decimal, `1e7`, `+30`,
    // an empty string and a kilobyte of digits are all "not an integer number of
    // base units", and enumerating them back to a caller only helps someone
    // probing the endpoint.
    return {
      ok: false,
      reason: "amountIn must be an integer number of USDC base units",
    };
  }

  const usdcIn = BigInt(amountIn);
  if (usdcIn < MIN_QUOTE_USDC_UNITS || usdcIn > MAX_QUOTE_USDC_UNITS) {
    return {
      ok: false,
      reason: `amountIn must be between ${MIN_QUOTE_USDC_UNITS} and ${MAX_QUOTE_USDC_UNITS} USDC base units`,
    };
  }

  return { ok: true, symbol, usdcIn };
}

/* ------------------------------------------------------------------ *
 * The browser seam.
 *
 * Quotes are fetched by `/api/quote`, not from the browser, so `Quote`
 * has to survive JSON: `bigint` does not serialise, and both amounts are
 * exact values that Part B will sign over, so they travel as decimal
 * strings rather than being rounded into a number.
 *
 * `detail` deliberately does not cross. It exists for the server log and
 * can carry upstream text; what the user reads is our own copy, chosen
 * from the three cases.
 * ------------------------------------------------------------------ */

export type QuoteWire = {
  kind: "quote";
  symbol: QuotableSymbol;
  usdcIn: string;
  usdIn: number;
  unitsOut: string;
  shares: number;
  usdPerShare: number;
  executionCostBps: number | null;
  gasUsd: number | null;
  routerAddress: string;
  receivedAtMs: number;
  expiresAtMs: number;
};

export type QuoteResultWire =
  | QuoteWire
  | { kind: "no-liquidity" }
  | { kind: "failed" };

export function toQuoteWire(result: QuoteResult): QuoteResultWire {
  // Spelled out per case rather than passing `result.kind` through: a union-typed
  // discriminant is not assignable to a union of literal-discriminated objects.
  if (result.kind === "no-liquidity") return { kind: "no-liquidity" };
  if (result.kind === "failed") return { kind: "failed" };

  const { quote } = result;
  return {
    kind: "quote",
    symbol: quote.symbol,
    usdcIn: quote.usdcIn.toString(),
    usdIn: quote.usdIn,
    unitsOut: quote.unitsOut.toString(),
    shares: quote.shares,
    usdPerShare: quote.usdPerShare,
    executionCostBps: quote.executionCostBps,
    gasUsd: quote.gasUsd,
    routerAddress: quote.routerAddress,
    receivedAtMs: quote.receivedAtMs,
    expiresAtMs: quote.expiresAtMs,
  };
}

/**
 * Parses our own route's response back into a `QuoteResult`.
 *
 * Validated field by field, never cast into shape. The payload arrives over a
 * network, and a truncated or proxied response has to read as `failed` — which the
 * browser can retry — rather than reach the panel as a number that renders as
 * `NaN` shares. Reading it as `Partial<QuoteWire>` would have asserted `usdcIn` is
 * a string and `shares` a number before anything checked either.
 *
 * All three wire cases genuinely arrive here. `/api/quote` sends a body on every
 * path and `hooks/useQuote.ts` parses it whatever the status, so `no-liquidity`
 * comes back with a 200, `failed` with a 502, and a rejected `symbol` or
 * `amountIn` with a 400 — all of them this function's business.
 */
export function parseQuoteWire(value: unknown): QuoteResult {
  if (!isRecord(value)) {
    return { kind: "failed", detail: "quote payload was not an object" };
  }

  // `value.kind` is `unknown`, and comparing an `unknown` against a string literal
  // is both legal and narrowing — so the discriminant is read off the payload
  // rather than assumed from a type we wrote down.
  if (value.kind === "no-liquidity") {
    return { kind: "no-liquidity", detail: "aggregator has no route" };
  }

  if (value.kind === "failed") {
    return { kind: "failed", detail: "the route reported a failed quote" };
  }

  if (value.kind !== "quote") {
    return { kind: "failed", detail: "quote payload was not a quote" };
  }

  // Two guards rather than `symbol in TOKEN_ADDRESSES`: `in` answers true for
  // inherited keys, so `constructor` would have passed it and then indexed the
  // registry with a key it does not own. `isStockSymbol` tests the array.
  const symbol = value.symbol;
  if (
    typeof symbol !== "string" ||
    !isStockSymbol(symbol) ||
    !isQuotableSymbol(symbol)
  ) {
    return {
      kind: "failed",
      detail: `quote payload named ${String(symbol)}, which we hold no address for`,
    };
  }

  const usdcIn = toBigInt(value.usdcIn);
  const unitsOut = toBigInt(value.unitsOut);
  const usdIn = toFiniteNumber(value.usdIn);
  const shares = toFiniteNumber(value.shares);
  const usdPerShare = toFiniteNumber(value.usdPerShare);
  const receivedAtMs = toFiniteNumber(value.receivedAtMs);
  const expiresAtMs = toFiniteNumber(value.expiresAtMs);

  if (
    usdcIn === null ||
    unitsOut === null ||
    usdIn === null ||
    shares === null ||
    usdPerShare === null ||
    receivedAtMs === null ||
    expiresAtMs === null ||
    shares <= 0 ||
    usdIn <= 0
  ) {
    return { kind: "failed", detail: "quote payload was incomplete" };
  }

  // The router is re-checked on the way in, not just on the way out. The payload
  // travelled a second network hop to get here, and this is the last boundary
  // before a `Quote` object exists in the browser — the object Part B will read a
  // spender out of. Same pin, same case-insensitive comparison, same fail-closed
  // treatment of absence.
  const routerAddress = value.routerAddress;
  if (
    typeof routerAddress !== "string" ||
    !sameAddress(routerAddress, KYBERSWAP_ROUTER_ADDRESS)
  ) {
    return {
      kind: "failed",
      detail:
        typeof routerAddress === "string"
          ? ROUTER_MISMATCH_DETAIL
          : ROUTER_ABSENT_DETAIL,
    };
  }

  return {
    kind: "quote",
    quote: {
      symbol,
      usdcIn,
      usdIn,
      unitsOut,
      shares,
      usdPerShare,
      executionCostBps: toFiniteNumber(value.executionCostBps),
      gasUsd: toFiniteNumber(value.gasUsd),
      routerAddress,
      receivedAtMs,
      expiresAtMs,
    },
  };
}

/**
 * Narrows an unknown to something whose properties can be read as `unknown`.
 *
 * Sound in the way a shape cast is not. This claims only that reading a key yields
 * *something*, which is true of every object — a missing key yields `undefined`,
 * and `undefined` is an `unknown`. `value as Partial<QuoteWire>` claimed `usdcIn`
 * is a string and `shares` a number, on data that had not been looked at yet.
 * `Envelope` and `RouteSummary` above are the same sound kind: every field on them
 * is declared `unknown`, so they name the fields we read without asserting types
 * for them.
 *
 * Arrays pass, which is correct — an array's `kind` is `undefined`, so it falls
 * through to `failed` a line later.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Address equality, case-insensitively.
 *
 * EIP-55 checksum casing is cosmetic, and the aggregator is under no obligation
 * to echo an address back in the casing we sent, so comparing the strings as
 * given would reject valid responses.
 */
function sameAddress(value: unknown, expected: string): boolean {
  return (
    typeof value === "string" && value.toLowerCase() === expected.toLowerCase()
  );
}

/** Base-10 integer strings only — these are token amounts, never hex, never floats. */
function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** Numbers, or numeric strings — the aggregator sends USD figures as strings. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined;
}
