"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  MAX_QUOTE_USDC_UNITS,
  MIN_QUOTE_USDC_UNITS,
  QUOTE_TTL_MS,
  ngnToUsdcUnits,
  parseQuoteWire,
  quoteMsRemaining,
  type Quote,
  type QuoteResult,
} from "@/lib/quote";
import { quoteBandNgn, withNgnQuote, type NgnQuote } from "@/lib/quote-ngn";
import {
  isQuotableSymbol,
  type QuotableSymbol,
  type StockSymbol,
} from "@/lib/tokens";

/**
 * A live quote for one market, keyed off the naira amount the user typed.
 *
 * Three behaviours, all of them required by the panel this feeds:
 *
 * - **Debounced.** Every keystroke would otherwise be a request to KyberSwap
 *   through our own route. The pause is short enough that the figure feels
 *   attached to the input.
 * - **Counted down.** A quote is presented as current for 30 seconds and no
 *   longer, because it is a price against pool depth that moves.
 * - **Refetched on expiry.** The countdown reaching zero replaces the quote
 *   rather than leaving a dead one on screen, so what the panel shows is either
 *   current or visibly being refreshed.
 *
 * Read-only, like everything in Phase 3 Part A: this asks what a trade would
 * cost. No approval, no signature, no submission.
 *
 * The naira rate is passed in rather than polled here. `useStockPrices` already
 * holds one from `useNGNRate`, and a second poller would mean two rates on one
 * screen that could disagree.
 */

/** How long we wait after the last keystroke before asking for a price. */
export const QUOTE_DEBOUNCE_MS = 400;

/** Countdown granularity. The panel renders whole seconds. */
const TICK_MS = 1_000;

export type QuoteStatus =
  /** Nothing to quote: no amount typed, or no naira rate to convert it with. */
  | "idle"
  /** No published address for this token, so there is nothing to ask about. */
  | "unquotable"
  /** Below the smallest order we will price. */
  | "too-small"
  /** Above the largest order we will price. */
  | "too-large"
  /** A request is in flight. */
  | "loading"
  /** A quote is held. Check `secondsRemaining` before presenting it as current. */
  | "quote"
  /** The aggregator answered and has no route at this size. */
  | "no-liquidity"
  /** We could not get an answer we trust. Retryable via `refresh`. */
  | "failed";

export type UseQuoteInput = {
  symbol: StockSymbol;
  /** Naira the user typed. Null when the field is empty. */
  ngn: number | null;
  /** USD to NGN, from `useNGNRate` — usually via `useStockPrices`. */
  usdToNgnRate: number | null;
  /**
   * Chainlink reference for this token in USD, for the premium row. Null when
   * there is no usable reading, which blanks the premium rather than computing
   * it against a number we do not have.
   */
  referenceUsd?: number | null;
};

export type UseQuoteResult = {
  status: QuoteStatus;
  /**
   * The held quote with naira joined on.
   *
   * Non-null through a refetch of the *same* amount, so the panel does not blank
   * every 30 seconds. Null the moment the amount changes, because a quote for a
   * different amount is not this amount's price.
   */
  ngnQuote: NgnQuote | null;
  /** Whole seconds left on the held quote. Null when none is held. */
  secondsRemaining: number | null;
  /** True when the held quote has run out and its replacement is not in yet. */
  expired: boolean;
  /** Smallest naira amount we will price, at today's rate. Null before a rate. */
  minNgn: number | null;
  /** Largest naira amount we will price, at today's rate. */
  maxNgn: number | null;
  /** Ask again now. Stable across renders. */
  refresh: () => void;
};

type Held = { status: QuoteStatus; quote: Quote | null };

const NOTHING: Held = { status: "idle", quote: null };

export function useQuote({
  symbol,
  ngn,
  usdToNgnRate,
  referenceUsd = null,
}: UseQuoteInput): UseQuoteResult {
  const [held, setHeld] = useState<Held>(NOTHING);
  const [nonce, setNonce] = useState(0);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [debounced, setDebounced] = useState<bigint | null>(null);

  /*
   * A `const` of the narrowed type rather than a boolean from the predicate.
   * TypeScript drops narrowing on a parameter once it is read inside a closure,
   * and the request below is made inside one.
   */
  const quotableSymbol: QuotableSymbol | null = isQuotableSymbol(symbol)
    ? symbol
    : null;

  // Recomputed every keystroke; the timer below decides when it becomes a
  // request. bigints compare by value, so an unchanged amount is not a change.
  const requested = ngn === null ? null : ngnToUsdcUnits(ngn, usdToNgnRate);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(requested), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [requested]);

  useEffect(() => {
    if (quotableSymbol === null) {
      setHeld({ status: "unquotable", quote: null });
      return;
    }
    if (debounced === null) {
      setHeld(NOTHING);
      return;
    }
    if (debounced < MIN_QUOTE_USDC_UNITS) {
      setHeld({ status: "too-small", quote: null });
      return;
    }
    if (debounced > MAX_QUOTE_USDC_UNITS) {
      setHeld({ status: "too-large", quote: null });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setHeld((previous) => ({
      status: "loading",
      // Held through a same-amount refresh so the panel does not blank every 30
      // seconds; dropped the moment the amount changes, because a quote for a
      // different amount is not this amount's price.
      quote:
        previous.quote !== null && previous.quote.usdcIn === debounced
          ? previous.quote
          : null,
    }));

    void (async () => {
      const result = await fetchQuote(quotableSymbol, debounced, controller.signal);
      if (cancelled) return;

      setHeld(
        result.kind === "quote"
          ? { status: "quote", quote: onArrival(result.quote) }
          : { status: result.kind, quote: null },
      );
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [quotableSymbol, debounced, nonce]);

  const heldQuote = held.quote;

  // Only a presentable quote is counted down. A quote kept on screen through a
  // refresh is already at zero and has nothing left to count.
  const counting = held.status === "quote" ? heldQuote : null;

  useEffect(() => {
    if (counting === null) return;

    const tick = () => setNowMs(Date.now());
    tick();

    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [counting]);

  const expired =
    counting !== null && nowMs !== null && nowMs >= counting.expiresAtMs;

  /*
   * Expiry replaces the quote rather than leaving a dead one on screen.
   *
   * Exactly one refetch per quote: the request sets the status to `loading`,
   * which empties `counting`, which stops the clock and settles `expired` back
   * to false until the replacement lands.
   */
  useEffect(() => {
    if (!expired) return;
    setNonce((previous) => previous + 1);
  }, [expired]);

  const ngnQuote = useMemo(
    () =>
      heldQuote === null
        ? null
        : withNgnQuote(heldQuote, usdToNgnRate, referenceUsd),
    [heldQuote, usdToNgnRate, referenceUsd],
  );

  const band = useMemo(() => quoteBandNgn(usdToNgnRate), [usdToNgnRate]);

  const refresh = useCallback(() => setNonce((previous) => previous + 1), []);

  return {
    status: held.status,
    ngnQuote,
    // Seeded from the quote's own arrival so the first frame reads the full TTL
    // rather than a blank while the clock waits for its first tick.
    secondsRemaining:
      heldQuote === null
        ? null
        : Math.ceil(
            quoteMsRemaining(heldQuote, nowMs ?? heldQuote.receivedAtMs) /
              TICK_MS,
          ),
    expired,
    minNgn: band.minNgn,
    maxNgn: band.maxNgn,
    refresh,
  };
}

/**
 * Restamps a quote on the clock that counts it down.
 *
 * `receivedAtMs` and `expiresAtMs` are set on the server. A phone clock a minute
 * out — common enough — would render a fresh quote as already expired, or hold a
 * dead one well past its life. The TTL is a duration, so measuring it locally
 * from arrival is both correct and immune to skew.
 */
function onArrival(quote: Quote): Quote {
  const arrivedAtMs = Date.now();
  return {
    ...quote,
    receivedAtMs: arrivedAtMs,
    expiresAtMs: arrivedAtMs + QUOTE_TTL_MS,
  };
}

/**
 * Fetches one quote from our own route.
 *
 * Never throws, for the same reason `requestQuote` does not: a rejected promise
 * here would surface as a blank panel. An aborted request resolves as `failed`
 * and is discarded by the caller before it can reach state.
 */
async function fetchQuote(
  symbol: QuotableSymbol,
  usdcIn: bigint,
  signal: AbortSignal,
): Promise<QuoteResult> {
  const query = new URLSearchParams({
    symbol,
    amountIn: usdcIn.toString(),
  });

  let response: Response;
  try {
    response = await fetch(`/api/quote?${query.toString()}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
  } catch (cause) {
    return {
      kind: "failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // Parsed rather than branched on status: our route sends a body on every path,
  // and the body is what says which of the three cases this is.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", detail: `HTTP ${response.status}, unreadable body` };
  }

  return parseQuoteWire(body);
}

