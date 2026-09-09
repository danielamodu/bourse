import type { Address } from "viem";

import { assertValidTokenAddress, parseAddress } from "@/lib/address";
import {
  KYBERSWAP_BUILD_URL,
  MAX_SLIPPAGE_BPS,
  SLIPPAGE_BPS,
  SWAP_DEADLINE_SEC,
  minAmountOutFor,
} from "@/lib/build";
import {
  computePremiumBps,
  scaleBigInt,
  toNgn,
} from "@/lib/price";
import {
  BOURSE_FEE_BPS,
  KYBERSWAP_ROUTES_URL,
  KYBERSWAP_ROUTER_ADDRESS,
  QUOTE_TTL_MS,
  ROUTER_ABSENT_DETAIL,
  ROUTER_MISMATCH_DETAIL,
  bourseFeeParams,
  clientId,
  executionCostBps,
  feeReceiver,
  sameAddress,
  toBigInt,
} from "@/lib/quote";
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
 * KyberSwap aggregator sell quotes. Tokenized stock in, USDC out.
 *
 * The mirror of `lib/quote.ts` plus the mirror of the build half of
 * `lib/build.ts`, in one module so the buy files stay exactly as they are.
 * Read-only until the wallet signs: this module asks what a sale would
 * return and encodes it, and never approves, signs or submits anything.
 *
 * SAME SECURITY TREATMENT, NO SHORTCUTS BECAUSE IT IS "JUST THE REVERSE":
 *
 * - The router the response names is checked against the same pin rather
 *   than carried through on trust — see {@link KYBERSWAP_ROUTER_ADDRESS}.
 *   In a sell the router pulls the *stock* under the same allowance, so a
 *   response choosing its own spender would be the same worst outcome.
 * - `tokenIn`, `tokenOut` and `amountIn` are echoed before any number is
 *   trusted, exactly like the buy path.
 * - `minAmountOut` is derived here from `amountOut` and the tolerance, never
 *   read off a response — it decides whether the swap reverts or settles.
 * - The calldata is shape-checked and never decoded, for the reason
 *   `lib/build.ts` gives at length: re-implementing the encoder to disagree
 *   with it teaches trust in a decode.
 * - `recipient` is the sender, set here and never read from a request, so no
 *   request routes one wallet's USDC proceeds to another.
 *
 * Callers pass token base units (the token's own 8 decimals). Naira never
 * enters this file: the rate lives in the browser, so the sell hook converts
 * in and back out again, the same split the buy path uses.
 */

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * The band of sale sizes we will ask about, in token base units.
 *
 * A transport guard, not an economic one: the bounds sit far outside any
 * real holding (dust at the bottom, a million shares at the top) and exist
 * so an unauthenticated endpoint never forwards an unbounded string to a
 * third party under our client id. Like the quote band, the cheap length
 * rejection goes before the conversion.
 */
export const MIN_SELL_TOKEN_UNITS = 1_000n;
export const MAX_SELL_TOKEN_UNITS = 100_000_000_000_000n;

/** Longest `amountIn` string the sell endpoints will even look at. */
const MAX_AMOUNT_IN_DIGITS = 24;

/** A priced sale. Every figure here is an estimate, and the UI says so. */
export type SellQuote = {
  symbol: QuotableSymbol;
  /** Stock spent, in token base units. Exact. */
  tokenIn: bigint;
  /** Shares spent, scaled by the token's `decimals()`. An estimate label. */
  sharesIn: number;
  /** USDC received, in USDC base units. As quoted. */
  usdcOut: bigint;
  /** The same proceeds as dollars, for display. */
  usdOut: number;
  /** What a share fetches on this route: `usdOut / sharesIn`. */
  usdPerShare: number;
  /**
   * What crossing the market costs, in basis points. Same measure as the buy
   * path — pool fee, spread and price-lookup disagreement, not size-dependent
   * slippage — and null when the aggregator did not price both legs.
   */
  executionCostBps: number | null;
  /** Gas the aggregator estimates for this route, in USD. Null when absent. */
  gasUsd: number | null;
  /** The same estimate in wei, for the low-ETH check. Null when unusable. */
  gasWei: bigint | null;
  /**
   * The router this route executes through. Never null on a quote that
   * exists: anything else is a `failed` result rather than a quote.
   */
  routerAddress: string;
  receivedAtMs: number;
  /** `receivedAtMs + QUOTE_TTL_MS`. Past this the panel stops presenting it. */
  expiresAtMs: number;
};

export type SellQuoteResult =
  /** The aggregator answered and has no route at this size. */
  | { kind: "quote"; quote: SellQuote }
  | { kind: "no-liquidity"; detail: string }
  /** We could not get an answer we trust. Retryable. */
  | { kind: "failed"; detail: string };

export type RequestSellQuoteOptions = {
  /** Injected in tests so the suite never touches the network. */
  fetchImpl?: typeof fetch;
  /** Injected so expiry is assertable. */
  nowMs?: number;
  /**
   * Called with the verbatim `routeSummary` of a route this module approved,
   * for `POST /route/build`. Same arrangement as the buy path: the summary
   * is handed over rather than returned, so `SellQuote` stays exactly what
   * the browser needs and the aggregator's routing data never crosses to it.
   */
  onRouteSummary?: (summary: Record<string, unknown>) => void;
};

/**
 * Asks KyberSwap what `tokenIn` of one stock token buys in USDC.
 *
 * Never throws: a thrown error at a quote boundary would surface to a user
 * as a blank panel, so every failure comes back as `failed` with the reason
 * attached for the log.
 */
export async function requestSellQuote(
  symbol: QuotableSymbol,
  tokenIn: bigint,
  options: RequestSellQuoteOptions = {},
): Promise<SellQuoteResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now();

  if (tokenIn <= 0n) {
    return { kind: "failed", detail: `amountIn must be positive, got ${tokenIn}` };
  }

  // Belt and braces beside the import-time shape assertion — a sell quote is
  // one of the boundaries where a counterfeit contract must stop dead.
  // Throwing is the point: a wrong-shaped address stops the operation rather
  // than degrading into a silent no-op.
  const tokenAddress = assertValidTokenAddress(
    TOKEN_ADDRESSES[symbol],
    `sell tokenIn for ${symbol}`,
  );
  const tokenDecimals = TOKEN_DECIMALS[symbol];

  const url = new URL(KYBERSWAP_ROUTES_URL);
  url.searchParams.set("tokenIn", tokenAddress);
  url.searchParams.set("tokenOut", USDC_ADDRESS);
  url.searchParams.set("amountIn", tokenIn.toString());
  // Without this the response carries no gas estimate, and estimated gas is
  // one of the figures the trade panel is required to show.
  url.searchParams.set("gasInclude", "true");

  const fee = bourseFeeParams(BOURSE_FEE_BPS, feeReceiver());
  if (fee.kind === "misconfigured") {
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

  const result = interpretSell(body, {
    symbol,
    tokenIn,
    tokenAddress,
    tokenDecimals,
    nowMs,
  });

  if (result.kind === "quote" && options.onRouteSummary !== undefined) {
    const summary = readRouteSummary(body);
    if (summary !== null) options.onRouteSummary(summary);
  }

  return result;
}

type InterpretSellContext = {
  symbol: QuotableSymbol;
  tokenIn: bigint;
  tokenAddress: string;
  tokenDecimals: number;
  nowMs: number;
};

/** `code: 0` plus `data.routeSummary` on success; a code and a message otherwise. */
type SellEnvelope = {
  code?: unknown;
  message?: unknown;
  data?: { routeSummary?: unknown; routerAddress?: unknown };
};

type SellRouteSummary = {
  tokenIn?: unknown;
  amountIn?: unknown;
  amountInUsd?: unknown;
  tokenOut?: unknown;
  amountOut?: unknown;
  amountOutUsd?: unknown;
  gas?: unknown;
  gasPrice?: unknown;
  gasUsd?: unknown;
  routerAddress?: unknown;
};

/**
 * Messages that mean the market, not the request.
 *
 * The same narrow set as the buy path, copied rather than shared so neither
 * module can widen the other's classification by editing one regex. Widen
 * only against wording seen in `verify/sell-quote.verify.ts` output.
 */
const NO_ROUTE_MESSAGE =
  /no route|route not found|cannot find route|insufficient liquidity|no pool/i;

function classifySellRejection(message: string, fallback: string): SellQuoteResult {
  if (NO_ROUTE_MESSAGE.test(message)) {
    return { kind: "no-liquidity", detail: message };
  }
  return { kind: "failed", detail: message === "" ? fallback : message };
}

function interpretSell(body: unknown, ctx: InterpretSellContext): SellQuoteResult {
  const envelope = (
    typeof body === "object" && body !== null ? body : {}
  ) as SellEnvelope;
  const message = typeof envelope.message === "string" ? envelope.message : "";
  const code = typeof envelope.code === "number" ? envelope.code : null;

  if (code !== null && code !== 0) {
    return classifySellRejection(message, `aggregator returned code ${code}`);
  }

  const raw: unknown = envelope.data?.routeSummary;
  if (typeof raw !== "object" || raw === null) {
    return classifySellRejection(message, "response carried no routeSummary");
  }
  const summary = raw as SellRouteSummary;

  /*
   * Guard the echo before trusting a single number out of it.
   *
   * The dangerous direction is reversed here and matters just as much: the
   * address we send is the stock, and the answer must be about the stock we
   * sent — priced in USDC, for exactly the amount we named.
   */
  if (!sameAddress(summary.tokenIn, ctx.tokenAddress)) {
    return {
      kind: "failed",
      detail: `tokenIn echoed as ${String(summary.tokenIn)}, asked for ${ctx.tokenAddress}`,
    };
  }

  if (!sameAddress(summary.tokenOut, USDC_ADDRESS)) {
    return {
      kind: "failed",
      detail: `tokenOut echoed as ${String(summary.tokenOut)}, asked for USDC`,
    };
  }

  const echoedIn = toBigInt(summary.amountIn);
  if (echoedIn !== null && echoedIn !== ctx.tokenIn) {
    return {
      kind: "failed",
      detail: `amountIn echoed as ${echoedIn}, sent ${ctx.tokenIn}`,
    };
  }

  const usdcOut = toBigInt(summary.amountOut);
  if (usdcOut === null) {
    return {
      kind: "failed",
      detail: `amountOut unreadable: ${String(summary.amountOut)}`,
    };
  }

  // A route that hands back nothing is a market answer, not a broken request.
  if (usdcOut <= 0n) {
    return { kind: "no-liquidity", detail: "route priced at zero out" };
  }

  const sharesIn = scaleBigInt(ctx.tokenIn, ctx.tokenDecimals);
  const usdOut = scaleBigInt(usdcOut, USDC_DECIMALS);

  if (!Number.isFinite(sharesIn) || sharesIn <= 0) {
    return {
      kind: "failed",
      detail: `could not scale ${ctx.tokenIn} at ${ctx.tokenDecimals} decimals`,
    };
  }

  if (!Number.isFinite(usdOut) || usdOut <= 0) {
    return {
      kind: "failed",
      detail: `could not scale ${usdcOut} at ${USDC_DECIMALS} decimals`,
    };
  }

  /*
   * The fourth echo guard, and the one with the most at stake.
   *
   * In a sell the router pulls the *stock* under the user's approval, so a
   * response is not allowed to name its own spender here either. Absence
   * fails closed alongside mismatch, for the buy path's reason: a response
   * that stopped naming a router is one whose route we can no longer tie to
   * the address we pinned.
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
      tokenIn: ctx.tokenIn,
      sharesIn,
      usdcOut,
      usdOut,
      usdPerShare: usdOut / sharesIn,
      executionCostBps: executionCostBps(
        toFiniteNumber(summary.amountInUsd),
        toFiniteNumber(summary.amountOutUsd),
      ),
      gasUsd: toFiniteNumber(summary.gasUsd),
      gasWei: gasWeiFrom(summary.gas, summary.gasPrice),
      // The echoed value, now known to be the pinned one bar casing. Kept as
      // received so a log line shows what the aggregator actually said.
      routerAddress: echoedRouter,
      receivedAtMs: ctx.nowMs,
      expiresAtMs: ctx.nowMs + QUOTE_TTL_MS,
    },
  };
}

/**
 * The verbatim `routeSummary` off a response, or null.
 *
 * A read, never a copy or a reshape — `POST /route/build` takes this object
 * back as the description of the route to encode.
 */
function readRouteSummary(body: unknown): Record<string, unknown> | null {
  const envelope = (
    typeof body === "object" && body !== null ? body : {}
  ) as SellEnvelope;
  const raw: unknown = envelope.data?.routeSummary;

  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : null;
}

/** Numbers, or numeric strings — the aggregator sends USD figures as strings. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The route's fee in wei: gas units times the gas price they were priced at.
 *
 * Null rather than zero on anything unreadable, because zero would claim the
 * trade is free and the one consumer of this figure warns about an ETH
 * balance from it.
 */
function gasWeiFrom(gas: unknown, gasPrice: unknown): bigint | null {
  const units = toBigInt(gas);
  const price = toBigInt(gasPrice);

  if (units === null || price === null) return null;
  if (units <= 0n || price <= 0n) return null;

  return units * price;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined;
}

/* ------------------------------------------------------------------ *
 * The quote seam: params in, wire across.
 * ------------------------------------------------------------------ */

export type SellQuoteParams =
  | { ok: true; symbol: QuotableSymbol; tokenIn: bigint }
  /** Reason to hand back verbatim as a 400. Names the parameter at fault. */
  | { ok: false; reason: string };

/**
 * Validates the query string `/api/sell-quote` was called with.
 *
 * Pure and here rather than in the route so it is covered by the offline
 * suite. `symbol` has to be one of the four we hold an address for — only
 * the four tradeable tokens are sellable, and a stock we know but hold no
 * address for is rejected by name. `amountIn` is token base units as an
 * integer string, bounded at both ends.
 */
export function parseSellQuoteParams(params: URLSearchParams): SellQuoteParams {
  const symbol = params.get("symbol");
  if (symbol === null || !isStockSymbol(symbol)) {
    return { ok: false, reason: "symbol must be one of the listed stocks" };
  }
  if (!isQuotableSymbol(symbol)) {
    return {
      ok: false,
      reason: `${symbol} has no token address on Base, so it cannot be sold`,
    };
  }

  const amountIn = params.get("amountIn");
  if (
    amountIn === null ||
    amountIn.length === 0 ||
    amountIn.length > MAX_AMOUNT_IN_DIGITS ||
    !/^\d+$/.test(amountIn)
  ) {
    return {
      ok: false,
      reason: "amountIn must be an integer number of token base units",
    };
  }

  const tokenIn = BigInt(amountIn);
  if (tokenIn < MIN_SELL_TOKEN_UNITS || tokenIn > MAX_SELL_TOKEN_UNITS) {
    return {
      ok: false,
      reason: `amountIn must be between ${MIN_SELL_TOKEN_UNITS} and ${MAX_SELL_TOKEN_UNITS} token base units`,
    };
  }

  return { ok: true, symbol, tokenIn };
}

export type SellQuoteWire = {
  kind: "quote";
  symbol: QuotableSymbol;
  tokenIn: string;
  sharesIn: number;
  usdcOut: string;
  usdOut: number;
  usdPerShare: number;
  executionCostBps: number | null;
  gasUsd: number | null;
  /** Wei as a decimal string, or null. Same reason as `tokenIn`: JSON has no bigint. */
  gasWei: string | null;
  routerAddress: string;
  receivedAtMs: number;
  expiresAtMs: number;
};

export type SellQuoteResultWire =
  | SellQuoteWire
  | { kind: "no-liquidity" }
  | { kind: "failed" };

export function toSellQuoteWire(result: SellQuoteResult): SellQuoteResultWire {
  if (result.kind === "no-liquidity") return { kind: "no-liquidity" };
  if (result.kind === "failed") return { kind: "failed" };

  const { quote } = result;
  return {
    kind: "quote",
    symbol: quote.symbol,
    tokenIn: quote.tokenIn.toString(),
    sharesIn: quote.sharesIn,
    usdcOut: quote.usdcOut.toString(),
    usdOut: quote.usdOut,
    usdPerShare: quote.usdPerShare,
    executionCostBps: quote.executionCostBps,
    gasUsd: quote.gasUsd,
    gasWei: quote.gasWei === null ? null : quote.gasWei.toString(),
    routerAddress: quote.routerAddress,
    receivedAtMs: quote.receivedAtMs,
    expiresAtMs: quote.expiresAtMs,
  };
}

/**
 * Parses our own sell-quote route's response back into a `SellQuoteResult`.
 *
 * Validated field by field, never cast into shape — the same boundary rule
 * as the buy path's `parseQuoteWire`, including the router re-check: the
 * payload travelled a second network hop, and this is the last boundary
 * before a `SellQuote` object exists in the browser.
 */
export function parseSellQuoteWire(value: unknown): SellQuoteResult {
  if (!isRecord(value)) {
    return { kind: "failed", detail: "sell quote payload was not an object" };
  }

  if (value.kind === "no-liquidity") {
    return { kind: "no-liquidity", detail: "aggregator has no route" };
  }

  if (value.kind === "failed") {
    return { kind: "failed", detail: "the route reported a failed sell quote" };
  }

  if (value.kind !== "quote") {
    return { kind: "failed", detail: "sell quote payload was not a quote" };
  }

  const symbol = value.symbol;
  if (
    typeof symbol !== "string" ||
    !isStockSymbol(symbol) ||
    !isQuotableSymbol(symbol)
  ) {
    return {
      kind: "failed",
      detail: `sell quote payload named ${String(symbol)}, which we hold no address for`,
    };
  }

  const tokenIn = toBigInt(value.tokenIn);
  const usdcOut = toBigInt(value.usdcOut);
  const usdOut = toFiniteNumber(value.usdOut);
  const sharesIn = toFiniteNumber(value.sharesIn);
  const usdPerShare = toFiniteNumber(value.usdPerShare);
  const receivedAtMs = toFiniteNumber(value.receivedAtMs);
  const expiresAtMs = toFiniteNumber(value.expiresAtMs);

  if (
    tokenIn === null ||
    usdcOut === null ||
    usdOut === null ||
    sharesIn === null ||
    usdPerShare === null ||
    receivedAtMs === null ||
    expiresAtMs === null ||
    sharesIn <= 0 ||
    usdOut <= 0
  ) {
    return { kind: "failed", detail: "sell quote payload was incomplete" };
  }

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
      tokenIn,
      sharesIn,
      usdcOut,
      usdOut,
      usdPerShare,
      executionCostBps: toFiniteNumber(value.executionCostBps),
      gasUsd: toFiniteNumber(value.gasUsd),
      gasWei: toBigInt(value.gasWei),
      routerAddress,
      receivedAtMs,
      expiresAtMs,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/* ------------------------------------------------------------------ *
 * The naira view of a sell quote.
 * ------------------------------------------------------------------ */

/** A sell quote with naira joined on: proceeds, rate and cost. */
export type SellNgnQuote = {
  quote: SellQuote;
  /** USDC proceeds in naira. The headline figure. */
  usdcOutNgn: number | null;
  /** Naira per share on this route. */
  ngnPerShare: number | null;
  /** Estimated gas, in naira. Paid in ETH, on top — never netted here. */
  gasNgn: number | null;
  /** Premium or discount against the Chainlink reference, in bps. */
  premiumBps: number | null;
  /** The market spread as naira, taken as `executionCostBps` of proceeds. */
  spreadNgn: number | null;
  /** Bourse's cut, in naira. Zero while the fee is zero. */
  feeNgn: number | null;
};

/**
 * Adds the naira figures and the premium to a sell quote. Pure.
 *
 * `referenceUsd` is the Chainlink reference for this token in USD, or null
 * when there is no usable reading — the premium then blanks rather than
 * computing against a number we do not have.
 */
export function withSellNgnQuote(
  quote: SellQuote,
  usdToNgnRate: number | null,
  referenceUsd: number | null = null,
): SellNgnQuote {
  const usdcOutNgn = toNgn(quote.usdOut, usdToNgnRate);

  return {
    quote,
    usdcOutNgn,
    ngnPerShare: toNgn(quote.usdPerShare, usdToNgnRate),
    gasNgn: toNgn(quote.gasUsd, usdToNgnRate),
    premiumBps: computePremiumBps(quote.usdPerShare, referenceUsd),
    spreadNgn: bpsOfSellNgn(usdcOutNgn, quote.executionCostBps),
    feeNgn: BOURSE_FEE_BPS <= 0 ? 0 : bpsOfSellNgn(usdcOutNgn, BOURSE_FEE_BPS),
  };
}

/** A basis-point share of a naira amount. Null in, null out. */
function bpsOfSellNgn(ngn: number | null, bps: number | null): number | null {
  if (ngn === null || bps === null) return null;
  if (!Number.isFinite(ngn) || !Number.isFinite(bps)) return null;

  const share = (ngn * bps) / 10_000;
  return Number.isFinite(share) ? share : null;
}

/* ------------------------------------------------------------------ *
 * The sell transaction, built by KyberSwap and checked by us.
 * ------------------------------------------------------------------ */

/** An unsigned sell, plus the figures the panel has to show beside it. */
export type SellTransaction = {
  symbol: QuotableSymbol;
  /**
   * Always {@link KYBERSWAP_ROUTER_ADDRESS} — our pinned constant, never the
   * address the response echoed.
   */
  to: string;
  /** Opaque calldata. Shape-checked, never decoded. */
  data: `0x${string}`;
  /**
   * Zero, as a literal type. A sale spends the stock through an allowance;
   * any ETH riding along would be a different transaction than asked for.
   */
  value: "0";
  /** Token base units in. Equal to the quote's `tokenIn`. */
  amountIn: bigint;
  /** USDC base units the built route returns. */
  amountOut: bigint;
  /** `amountOut` less the tolerance, computed here. */
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

export type SellBuildResult =
  | { kind: "transaction"; transaction: SellTransaction }
  | { kind: "refused"; detail: string }
  | { kind: "failed"; detail: string };

export type SellBuildOptions = {
  /** Injected in tests so the suite never touches the network. */
  fetchImpl?: typeof fetch;
  /** Injected so the deadline and the quote's expiry are both assertable. */
  nowMs?: number;
};

/** A sell quote, with the routing data needed to build it. */
export type RoutedSellQuote = {
  result: SellQuoteResult;
  /** Verbatim, as KyberSwap sent it. Null unless `result` is a quote. */
  routeSummary: Record<string, unknown> | null;
};

export type BuildSellParams = {
  /** The sell quote the summary came from. */
  quote: SellQuote;
  /** Verbatim from {@link requestSellRoute}. Never rebuilt, never reshaped. */
  routeSummary: Record<string, unknown>;
  /** The signer. Becomes `recipient` too — the USDC comes back to the seller. */
  sender: string;
  /** USDC base units: the floor under the quote the user was actually shown. */
  minAmountOut: bigint;
  /** Defaults to {@link SLIPPAGE_BPS}. */
  slippageBps?: number;
};

export type PrepareSellParams = {
  symbol: QuotableSymbol;
  tokenIn: bigint;
  sender: string;
  minAmountOut: bigint;
  slippageBps?: number;
};

/** In the band this module will encode, and a whole number of basis points. */
function isSlippageBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= MAX_SLIPPAGE_BPS;
}

/**
 * A sell quote, and the `routeSummary` it came from.
 *
 * Same capture arrangement as the buy path's `requestRoute`: the holder
 * object defeats control-flow narrowing that would otherwise keep the
 * captured summary unreadable below the callback.
 */
export async function requestSellRoute(
  symbol: QuotableSymbol,
  tokenIn: bigint,
  options: SellBuildOptions = {},
): Promise<RoutedSellQuote> {
  const captured: { summary: Record<string, unknown> | null } = {
    summary: null,
  };

  const result = await requestSellQuote(symbol, tokenIn, {
    fetchImpl: options.fetchImpl,
    nowMs: options.nowMs,
    onRouteSummary: (summary) => {
      captured.summary = summary;
    },
  });

  return { result, routeSummary: captured.summary };
}

/**
 * Asks KyberSwap to encode a sell route it already quoted, and checks what
 * comes back. Never throws.
 */
export async function buildSellSwap(
  params: BuildSellParams,
  options: SellBuildOptions = {},
): Promise<SellBuildResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now();
  const slippageBps = params.slippageBps ?? SLIPPAGE_BPS;

  /*
   * The sender is canonicalised here, not trusted from the caller. It is
   * about to be sent as both `sender` and `recipient`, which makes it the
   * account every USDC of proceeds lands in.
   */
  const sender = parseAddress(params.sender);
  if (sender === null) {
    return {
      kind: "refused",
      detail: `build-sender-invalid: ${String(params.sender)} is not an address we will build for`,
    };
  }

  if (!isSlippageBps(slippageBps)) {
    return {
      kind: "refused",
      detail: `build-slippage-invalid: ${slippageBps} is outside 0-${MAX_SLIPPAGE_BPS}bps`,
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
        routeSummary: params.routeSummary,
        sender,
        // Set here, from the sender, and never read from a request: the
        // proceeds go back to the seller, full stop.
        recipient: sender,
        slippageTolerance: slippageBps,
        deadline,
        source: clientId(),
      }),
      cache: "no-store",
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    return { kind: "failed", detail: `request threw: ${describe(cause)}` };
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

  return interpretSellBuild(body, {
    symbol: params.quote.symbol,
    amountIn: params.quote.tokenIn,
    floor: params.minAmountOut,
    slippageBps,
    deadline,
    expiresAt: params.quote.expiresAtMs,
  });
}

/**
 * Quote and build, in one call: what `/api/sell` does.
 *
 * A fresh route, because calldata has to encode a route that exists now.
 * The fresh route's output is checked against the floor derived from the
 * quote the user was shown before a build call is spent on it.
 */
export async function prepareSellSwap(
  params: PrepareSellParams,
  options: SellBuildOptions = {},
): Promise<SellBuildResult> {
  const { result, routeSummary } = await requestSellRoute(
    params.symbol,
    params.tokenIn,
    options,
  );

  if (result.kind === "no-liquidity") {
    return { kind: "refused", detail: `no-route-at-this-size: ${result.detail}` };
  }

  if (result.kind === "failed") {
    return { kind: "failed", detail: result.detail };
  }

  if (routeSummary === null) {
    return {
      kind: "failed",
      detail: "route-summary-absent: quote carried no routeSummary to build from",
    };
  }

  if (result.quote.usdcOut < params.minAmountOut) {
    return {
      kind: "refused",
      detail: `price-moved-re-quote: route now returns ${result.quote.usdcOut}, the quote shown was floored at ${params.minAmountOut}`,
    };
  }

  return buildSellSwap(
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

/** The build response, as far as we read it. Every field `unknown` on purpose. */
type SellBuildEnvelope = {
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

/** What the sell-build guards check the response against. */
type SellBuildContext = {
  symbol: QuotableSymbol;
  /** The quote's `tokenIn`. The build must state this back. */
  amountIn: bigint;
  /** USDC base units: the floor under the quote the user was shown. */
  floor: bigint;
  slippageBps: number;
  deadline: number;
  expiresAt: number;
};

/**
 * Every guard, in order, against one response body. Pure.
 *
 * Same order as the buy path, for the buy path's reason: the router first
 * because it is the spender of the stock approval, then the identity check,
 * then the value checks, then the shape checks.
 */
function interpretSellBuild(body: unknown, ctx: SellBuildContext): SellBuildResult {
  const envelope = (
    typeof body === "object" && body !== null ? body : {}
  ) as SellBuildEnvelope;
  const message = typeof envelope.message === "string" ? envelope.message : "";
  const code = typeof envelope.code === "number" ? envelope.code : null;

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

  // GUARD 1 — the router, against the pin. In a sell this address is the
  // spender of the *stock* approval, so a mismatch here is the same worst
  // outcome wearing the other token.
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

  // GUARD 2 — `amountIn`, stated back exactly. What the calldata will pull
  // from the seller's stock balance, in that token's own units.
  const statedIn = toBigInt(data.amountIn);
  if (statedIn === null || statedIn !== ctx.amountIn) {
    return {
      kind: "refused",
      detail: `build-amount-in-mismatch: build states ${String(data.amountIn)}, quoted ${ctx.amountIn}`,
    };
  }

  // GUARD 3 — `amountOut` is a positive integer of USDC base units.
  const amountOut = toBigInt(data.amountOut);
  if (amountOut === null || amountOut <= 0n) {
    return {
      kind: "refused",
      detail: `build-amount-out-unreadable: ${String(data.amountOut)}`,
    };
  }

  // GUARD 4 — the built route is not materially worse than the quote shown,
  // measured against the floor with the tolerance applied.
  const tolerated = minAmountOutFor(ctx.floor, ctx.slippageBps);
  if (tolerated === null) {
    return {
      kind: "failed",
      detail: `build-slippage-invalid: cannot derive a floor at ${ctx.slippageBps}bps`,
    };
  }
  if (amountOut < tolerated) {
    return {
      kind: "refused",
      detail: `build-amount-out-shortfall: build returns ${amountOut}, floor ${ctx.floor} less ${ctx.slippageBps}bps is ${tolerated}`,
    };
  }

  // GUARD 5 — no ETH rides along. A sale moves stock and returns USDC.
  const value = toBigInt(data.transactionValue);
  if (value === null || value !== 0n) {
    return {
      kind: "refused",
      detail: `build-transaction-value-not-zero: ${String(data.transactionValue)}`,
    };
  }

  // GUARD 6 — the calldata is bytes. Shape only, never decoded.
  if (!isCalldata(data.data)) {
    return {
      kind: "refused",
      detail: `build-calldata-malformed: ${describeCalldata(data.data)}`,
    };
  }

  const minAmountOut = minAmountOutFor(amountOut, ctx.slippageBps);
  if (minAmountOut === null) {
    return {
      kind: "failed",
      detail: `build-slippage-invalid: cannot derive a floor at ${ctx.slippageBps}bps`,
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
      minAmountOut,
      slippageBps: ctx.slippageBps,
      gas: toBigInt(data.gas),
      deadline: ctx.deadline,
      expiresAt: ctx.expiresAt,
    },
  };
}

/** True when a non-success result carries this code. */
function hasCode(result: SellBuildResult, code: string): boolean {
  return result.kind !== "transaction" && result.detail.startsWith(`${code}:`);
}

/** The refusal that means "quote again", not "try again". */
export function isSellPriceMoved(result: SellBuildResult): boolean {
  return hasCode(result, "price-moved-re-quote");
}

/** The refusal that means the market, not the request. */
export function isSellNoRoute(result: SellBuildResult): boolean {
  return hasCode(result, "no-route-at-this-size");
}

/**
 * Calldata, by shape alone. A type predicate so the success case assigns
 * without a cast — the narrowing is the check.
 */
function isCalldata(value: unknown): value is `0x${string}` {
  return typeof value === "string" && CALLDATA_SHAPE.test(value);
}

/**
 * `0x` plus whole bytes of hex, and nothing else. The `{2}` rejects an odd
 * run of hex, which cannot be bytes, and the `+` rejects a bare `0x`, which
 * is a transaction with no function selector.
 */
const CALLDATA_SHAPE = /^0x([0-9a-fA-F]{2})+$/;

function describeCalldata(value: unknown): string {
  if (typeof value !== "string") return `not a string (${typeof value})`;
  if (value.length === 0) return "empty string";

  return `${value.length} chars starting ${value.slice(0, 10)}`;
}

/* ------------------------------------------------------------------ *
 * The sell-build request seam: what `/api/sell` validates.
 * ------------------------------------------------------------------ */

export type SellBuildParams =
  | {
      ok: true;
      symbol: QuotableSymbol;
      tokenIn: bigint;
      /** Canonical EIP-55. Becomes `recipient` too, inside {@link buildSellSwap}. */
      sender: Address;
      /** USDC base units: the floor the browser was shown. */
      minAmountOut: bigint;
    }
  /** Reason to hand back verbatim as a 400. Names the field at fault. */
  | { ok: false; reason: string };

/**
 * Validates the JSON body `/api/sell` was posted.
 *
 * Pure, and the whole input surface of the endpoint. Four fields, and no
 * fifth: `recipient` is deliberately not among them — the proceeds go back
 * to the sender, and there is no request that says otherwise. `minAmountOut`
 * must be a positive integer of USDC base units: zero would read as "no
 * floor", which is a sale at whatever price comes back.
 */
export function parseSellBuildBody(body: unknown): SellBuildParams {
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

  const quoted = parseSellQuoteParams(params);
  if (!quoted.ok) return quoted;

  // `parseAddress`, not the token shape check: a seller is a wallet, not a
  // `0xb2…` precompile. It also canonicalises and rejects a mixed-case
  // address whose checksum does not hold — the proceeds go to this address.
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
    typeof stated === "string" && stated.length <= MAX_AMOUNT_IN_DIGITS
      ? toBigInt(stated)
      : null;

  if (minAmountOut === null || minAmountOut <= 0n) {
    return {
      ok: false,
      reason:
        "minAmountOut must be a positive integer number of USDC base units",
    };
  }

  return {
    ok: true,
    symbol: quoted.symbol,
    tokenIn: quoted.tokenIn,
    sender,
    minAmountOut,
  };
}

/**
 * The sell as it crosses to the browser.
 *
 * `bigint` does not survive JSON, and these are exact amounts, so they
 * travel as decimal strings rather than being rounded into a number.
 */
export type SellTransactionWire = {
  kind: "transaction";
  /** The pinned router — our constant, not the address the response echoed. */
  to: string;
  data: `0x${string}`;
  value: "0";
  /** USDC base units the route returns. */
  amountOut: string;
  /** USDC base units, derived by us from `amountOut` and the tolerance. */
  minAmountOut: string;
  /** Gas units the aggregator estimated, or null when it did not say. */
  gas: string | null;
  /** Unix ms: the quote's expiry, so the panel counts one clock. */
  expiresAt: number;
};

export function toSellSwapWire(transaction: SellTransaction): SellTransactionWire {
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

/** What the browser has after reading a sell-build payload. */
export type ParsedSellSwap = {
  /** The pin, as a checked-and-then-discarded echo. */
  to: string;
  data: `0x${string}`;
  value: "0";
  amountOut: bigint;
  minAmountOut: bigint;
  gas: bigint | null;
  expiresAt: number;
};

export type SellSwapWireResult =
  | { kind: "transaction"; transaction: ParsedSellSwap }
  | { kind: "unsafe"; detail: string }
  | { kind: "unreadable"; detail: string };

/**
 * The last checks before a wallet is asked for a sell signature.
 *
 * THE BROWSER IS WHERE THIS VALUE IS USED, SO THE BROWSER IS WHERE IT IS
 * CHECKED — same guarantee as the buy path's `parseSwapWire`, restated where
 * it matters. A tampered `to` hands a stock approval to an attacker's
 * contract; a non-zero `value` drains ETH on top of the sale.
 */
export function parseSellSwapWire(body: unknown): SellSwapWireResult {
  if (typeof body !== "object" || body === null) {
    return { kind: "unreadable", detail: "sell build payload was not an object" };
  }

  const value = body as Record<string, unknown>;

  if (value.kind !== "transaction") {
    return { kind: "unreadable", detail: "sell build payload was not a transaction" };
  }

  const to = value.to;
  const sent = value.value;
  const data = value.data;

  if (typeof to !== "string") {
    return { kind: "unsafe", detail: ROUTER_ABSENT_DETAIL };
  }

  if (!sameAddress(to, KYBERSWAP_ROUTER_ADDRESS)) {
    return {
      kind: "unsafe",
      detail: `${ROUTER_MISMATCH_DETAIL}: payload named ${to}, pinned ${KYBERSWAP_ROUTER_ADDRESS}`,
    };
  }

  if (sent !== "0") {
    return {
      kind: "unsafe",
      detail: `build-transaction-value-not-zero: payload said ${String(sent)}`,
    };
  }

  if (!isCalldata(data)) {
    return {
      kind: "unsafe",
      detail: `build-calldata-malformed: ${describeCalldata(data)}`,
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
    return { kind: "unreadable", detail: "sell build payload was incomplete" };
  }

  if (minAmountOut > amountOut) {
    return {
      kind: "unsafe",
      detail: `build-amount-out-shortfall: floor ${minAmountOut} above the ${amountOut} quoted`,
    };
  }

  return {
    kind: "transaction",
    transaction: {
      // The pinned constant, not the string just checked against it.
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
