"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { QUOTE_TTL_MS, quoteMsRemaining } from "@/lib/quote";
import {
  MAX_SELL_TOKEN_UNITS,
  MIN_SELL_TOKEN_UNITS,
  parseSellQuoteWire,
  withSellNgnQuote,
  type SellNgnQuote,
  type SellQuote,
  type SellQuoteResult,
} from "@/lib/sell";
import {
  TOKEN_DECIMALS,
  isQuotableSymbol,
  type QuotableSymbol,
  type StockSymbol,
} from "@/lib/tokens";

import type { QuoteStatus } from "./useQuote";

/**
 * A live sell quote for one market, keyed off the shares the user typed.
 *
 * The mirror of `hooks/useQuote.ts`: debounced, counted down for the same 30
 * seconds, and refetched on expiry so what the panel shows is either current
 * or visibly being refreshed. It prices, and it signs nothing.
 *
 * Amounts here are shares — what a seller holds — converted to the token's
 * base units before anything is asked. The naira rate is passed in rather
 * than polled here, for the buy path's reason: one rate per screen.
 */

export const SELL_QUOTE_DEBOUNCE_MS = 400;

/** Countdown granularity. The panel renders whole seconds. */
const TICK_MS = 1_000;

export type UseSellQuoteInput = {
  symbol: StockSymbol;
  /** Shares the user typed. Null when the field is empty. */
  shares: number | null;
  /** USD to NGN, from `useNGNRate` — usually via `useStockPrices`. */
  usdToNgnRate: number | null;
  /** Chainlink reference for this token in USD, for the premium row. */
  referenceUsd?: number | null;
};

export type UseSellQuoteResult = {
  status: QuoteStatus;
  /**
   * The held quote with naira joined on. Non-null through a refetch of the
   * *same* amount; null the moment the amount changes.
   */
  sellQuote: SellNgnQuote | null;
  /** Whole seconds left on the held quote. Null when none is held. */
  secondsRemaining: number | null;
  /** True when the held quote has run out and its replacement is not in yet. */
  expired: boolean;
  /** Smallest share amount we will price, at this token's decimals. */
  minShares: number | null;
  /** Largest share amount we will price. */
  maxShares: number | null;
  /** Ask again now. Stable across renders. */
  refresh: () => void;
};

type Held = { status: QuoteStatus; quote: SellQuote | null };

const NOTHING: Held = { status: "idle", quote: null };

export function useSellQuote({
  symbol,
  shares,
  usdToNgnRate,
  referenceUsd = null,
}: UseSellQuoteInput): UseSellQuoteResult {
  const [held, setHeld] = useState<Held>(NOTHING);
  const [nonce, setNonce] = useState(0);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [debounced, setDebounced] = useState<bigint | null>(null);

  /*
   * A `const` of the narrowed type rather than a boolean from the predicate,
   * for the buy path's reason: TypeScript drops narrowing on a parameter once
   * it is read inside a closure, and the request below is made inside one.
   */
  const quotableSymbol: QuotableSymbol | null = isQuotableSymbol(symbol)
    ? symbol
    : null;
  const decimals = quotableSymbol === null ? null : TOKEN_DECIMALS[quotableSymbol];

  // Recomputed every keystroke; the timer below decides when it becomes a
  // request. Rounded down: overstating what is sold would quote a sale the
  // wallet cannot cover.
  const requested =
    shares === null || decimals === null || !Number.isFinite(shares) || shares <= 0
      ? null
      : BigInt(Math.floor(shares * 10 ** decimals));

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(requested), SELL_QUOTE_DEBOUNCE_MS);
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
    if (debounced < MIN_SELL_TOKEN_UNITS) {
      setHeld({ status: "too-small", quote: null });
      return;
    }
    if (debounced > MAX_SELL_TOKEN_UNITS) {
      setHeld({ status: "too-large", quote: null });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setHeld((previous) => ({
      status: "loading",
      quote:
        previous.quote !== null && previous.quote.tokenIn === debounced
          ? previous.quote
          : null,
    }));

    void (async () => {
      const result = await fetchSellQuote(quotableSymbol, debounced, controller.signal);
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

  useEffect(() => {
    if (!expired) return;
    setNonce((previous) => previous + 1);
  }, [expired]);

  const sellQuote = useMemo(
    () =>
      heldQuote === null
        ? null
        : withSellNgnQuote(heldQuote, usdToNgnRate, referenceUsd),
    [heldQuote, usdToNgnRate, referenceUsd],
  );

  const refresh = useCallback(() => setNonce((previous) => previous + 1), []);

  return {
    status: held.status,
    sellQuote,
    secondsRemaining:
      heldQuote === null
        ? null
        : Math.ceil(
            quoteMsRemaining(heldQuote, nowMs ?? heldQuote.receivedAtMs) /
              TICK_MS,
          ),
    expired,
    minShares:
      decimals === null ? null : Number(MIN_SELL_TOKEN_UNITS) / 10 ** decimals,
    maxShares:
      decimals === null ? null : Number(MAX_SELL_TOKEN_UNITS) / 10 ** decimals,
    refresh,
  };
}

/**
 * Restamps a quote on the local clock. Same skew argument as the buy path:
 * server timestamps are durations measured locally from arrival.
 */
function onArrival(quote: SellQuote): SellQuote {
  const arrivedAtMs = Date.now();
  return {
    ...quote,
    receivedAtMs: arrivedAtMs,
    expiresAtMs: arrivedAtMs + QUOTE_TTL_MS,
  };
}

/**
 * Fetches one sell quote from our own route. Never throws: a rejection here
 * would surface as a blank panel, so an abort resolves as `failed` and is
 * discarded by the caller before it can reach state.
 */
async function fetchSellQuote(
  symbol: QuotableSymbol,
  tokenIn: bigint,
  signal: AbortSignal,
): Promise<SellQuoteResult> {
  const query = new URLSearchParams({
    symbol,
    amountIn: tokenIn.toString(),
  });

  let response: Response;
  try {
    response = await fetch(`/api/sell-quote?${query.toString()}`, {
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

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", detail: `HTTP ${response.status}, unreadable body` };
  }

  return parseSellQuoteWire(body);
}
