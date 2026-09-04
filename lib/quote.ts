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
 * approval, no signature, no submission. `routerAddress` comes back and is
 * recorded rather than used.
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

/** How long a quote is presented as current. Also the refetch interval. */
export const QUOTE_TTL_MS = 30_000;

/**
 * Most a route may cost in slippage before we stop calling a token buyable.
 *
 * 3% is deliberately loose for a ₦50,000 ticket — about $30, which is noise even
 * in a shallow pool — so a token failing this is genuinely unbuyable rather than
 * merely thin. Tradeability is measured at the user's real order size, so a large
 * order can fail the budget on a token a small order passes on. That is the
 * correct behaviour and not a bug to smooth over.
 */
export const PRICE_IMPACT_BUDGET_BPS = 300;

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
   * Value given up crossing the pool, in basis points. Null when the aggregator
   * did not price both legs, which reads as unknown and never as zero.
   */
  priceImpactBps: number | null;
  /** Gas the aggregator estimates for this route, in USD. Null when absent. */
  gasUsd: number | null;
  /** The router this route would execute through. Recorded, never called here. */
  routerAddress: string | null;
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

  return {
    kind: "quote",
    quote: {
      symbol: ctx.symbol,
      usdcIn: ctx.usdcIn,
      usdIn,
      unitsOut,
      shares,
      usdPerShare: usdIn / shares,
      priceImpactBps: priceImpactBps(
        toFiniteNumber(summary.amountInUsd),
        toFiniteNumber(summary.amountOutUsd),
      ),
      gasUsd: toFiniteNumber(summary.gasUsd),
      routerAddress:
        typeof summary.routerAddress === "string"
          ? summary.routerAddress
          : typeof envelope.data?.routerAddress === "string"
            ? envelope.data.routerAddress
            : null,
      receivedAtMs: ctx.nowMs,
      expiresAtMs: ctx.nowMs + QUOTE_TTL_MS,
    },
  };
}

/**
 * Value given up crossing the pool, in basis points, from the aggregator's own
 * valuation of both legs.
 *
 * Null rather than zero when either leg is unpriced: "we do not know the impact"
 * and "the impact is nil" are different statements, and only one of them should
 * ever let a buy affordance render.
 *
 * Rounded up to a whole basis point rather than to the nearest one — the contract
 * is stated on {@link ceilBps}. `Math.round` reported half a basis point of cost
 * as none at all, and a tenth of one likewise, which reads as a free route; a cost
 * this function cannot state precisely is stated high. Zero is therefore reserved
 * for a route with no measurable cost, and `formatImpactBps` renders it as a
 * threshold rather than as an exact `0.00%`.
 *
 * A negative result is clamped to zero. It means the aggregator valued the output
 * slightly above the input, which is two independent price lookups disagreeing —
 * not a gain, and not something to display as one.
 */
export function priceImpactBps(
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
  priceImpactBps: number | null;
  gasUsd: number | null;
  routerAddress: string | null;
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
    priceImpactBps: quote.priceImpactBps,
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

  return {
    kind: "quote",
    quote: {
      symbol,
      usdcIn,
      usdIn,
      unitsOut,
      shares,
      usdPerShare,
      priceImpactBps: toFiniteNumber(value.priceImpactBps),
      gasUsd: toFiniteNumber(value.gasUsd),
      routerAddress:
        typeof value.routerAddress === "string" ? value.routerAddress : null,
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
