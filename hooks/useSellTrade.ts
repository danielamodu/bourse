"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import {
  useReadContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { tokenAllowanceAbi } from "@/lib/abi";
import { parseAddress } from "@/lib/address";
import { SLIPPAGE_BPS, minAmountOutFor } from "@/lib/build";
import { KYBERSWAP_ROUTER_ADDRESS, isQuoteExpired } from "@/lib/quote";
import { BASE_CHAIN_ID } from "@/lib/rpc";
import {
  parseSellSwapWire,
  type ParsedSellSwap,
  type SellQuote,
} from "@/lib/sell";
import { TOKEN_ADDRESSES } from "@/lib/tokens";
import {
  tradeState,
  txPhase,
  type TradeState,
  type TxPhase,
} from "@/lib/trade-state";
import type { WalletState } from "@/lib/wallet-state";

import type { TradeFault } from "./useTrade";

/**
 * The sale, as far as the browser is involved in it.
 *
 * The mirror of `hooks/useTrade.ts`: the only place that asks a wallet for a
 * sell signature. The checks flip exactly where the user said they must —
 * the approval and the allowance read name the *stock* token contract, and
 * the balance gate reads the stock balance — and nowhere else. Everything
 * structural is shared: the spender is the pinned router as an import, the
 * swap's `to` and zero `value` are literals at the send site, the approval
 * is for the exact amount, the allowance is re-read after it confirms, and a
 * build that came back unsafe is terminal.
 *
 * IT DECIDES NOTHING ABOUT WHAT THE PANEL SAYS. Every result gathered here
 * feeds `tradeState` in `lib/trade-state.ts`, with `balance` carrying the
 * stock balance the buy flow leaves null.
 */

export type UseSellTradeInput = {
  /**
   * The sell quote on screen, from `useSellQuote`. Null when there is nothing
   * to sell: before an amount is typed, between amounts, or after a refetch
   * that failed.
   */
  quote: SellQuote | null;
  /** `useSellQuote`'s own expiry flag, so one clock ticks for the whole panel. */
  quoteExpired: boolean;
  /** `useSellQuote`'s `refresh`. Called on a 409 and by {@link UseSellTradeResult.retry}. */
  refreshQuote: () => void;
  /** From `useWallet`. Anything but `ready` blocks, and `tradeState` decides that. */
  wallet: WalletState;
  /** The connected address. Allowance owner and proceeds recipient. */
  owner: string | null;
  /**
   * Stock balance of the connected wallet, in token base units — or null
   * until read. Feeds `tradeState`'s balance gate, which the buy flow leaves
   * null. Null means "not judged", never "zero".
   */
  balance: bigint | null;
};

export type UseSellTradeResult = {
  /** What to render, from `tradeState`. Null only with no amount to talk about. */
  state: TradeState | null;
  /**
   * The floor in USDC base units: the built figure once a build has landed,
   * the quote's own floor before that. Null with no quote.
   */
  minAmountOut: bigint | null;
  /** The approval's hash, for a Basescan link. Null before one is sent. */
  approvalHash: string | null;
  /** The swap's hash, for the same reason. */
  swapHash: string | null;
  /** Why a `failed` state happened, when a build is the reason. */
  fault: TradeFault | null;
  /** The price moved between the quote shown and the route built. */
  repriced: boolean;
  /**
   * The on-screen quote is the refused one and its replacement has not
   * landed yet. Nothing can be submitted in that window.
   */
  awaitingReprice: boolean;
  /** The primary button. A no-op in every state that is not an action. */
  submit: () => void;
  /** Clear a finished or failed attempt and quote again. */
  retry: () => void;
};

export function useSellTrade({
  quote,
  quoteExpired,
  refreshQuote,
  wallet,
  owner,
  balance,
}: UseSellTradeInput): UseSellTradeResult {
  const sender = useMemo(() => parseAddress(owner), [owner]);

  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState<ParsedSellSwap | null>(null);
  const [fault, setFault] = useState<TradeFault | null>(null);
  const [engaged, setEngaged] = useState<bigint | null>(null);
  const [repricedFrom, setRepricedFrom] = useState<number | null>(null);
  const [rereadFor, setRereadFor] = useState<string | null>(null);

  // The stock token being sold — resolved from the quote's own symbol, which
  // came from our registry through our route. Never an address off a request.
  const tokenAddress = quote === null ? undefined : TOKEN_ADDRESSES[quote.symbol];

  /**
   * Bumped by every reset, captured by every build. A press of "start over"
   * or an account switch mid-build must not let the late response send a
   * transaction for a trade that is no longer on screen.
   */
  const flow = useRef(0);

  const allowanceRead = useReadContract({
    address: tokenAddress,
    abi: tokenAllowanceAbi,
    functionName: "allowance",
    // The spender is the pinned router, imported. Never an address off a
    // response, and never USDC — this is the stock's own allowance, for the
    // contract that will pull it.
    args:
      sender === null
        ? undefined
        : ([sender, KYBERSWAP_ROUTER_ADDRESS] as const),
    chainId: BASE_CHAIN_ID,
    query: { enabled: sender !== null && tokenAddress !== undefined },
  });

  const {
    writeContract: approve,
    data: approvalHash,
    error: approvalError,
    isPending: approvalSigning,
    reset: resetApproval,
  } = useWriteContract();

  const {
    sendTransaction: send,
    data: swapHash,
    error: swapError,
    isPending: swapSigning,
    reset: resetSwap,
  } = useSendTransaction();

  const approvalReceipt = useWaitForTransactionReceipt({
    hash: approvalHash,
    chainId: BASE_CHAIN_ID,
    query: { enabled: approvalHash !== undefined },
  });

  const swapReceipt = useWaitForTransactionReceipt({
    hash: swapHash,
    chainId: BASE_CHAIN_ID,
    query: { enabled: swapHash !== undefined },
  });

  const approval = txPhase({
    signing: approvalSigning,
    hash: approvalHash ?? null,
    writeError: approvalError,
    receipt: approvalReceipt.data?.status ?? null,
    receiptError: approvalReceipt.error,
  });

  const sent = txPhase({
    signing: swapSigning,
    hash: swapHash ?? null,
    writeError: swapError,
    receipt: swapReceipt.data?.status ?? null,
    receiptError: swapReceipt.error,
  });

  /*
   * A build that failed is reported as a swap that failed — the buy path's
   * reasoning, unchanged: one press is one action, and the build is a step
   * inside it that happens before the wallet opens.
   */
  const swap: TxPhase = fault !== null && sent === "idle" ? "failed" : sent;

  const confirmedApproval =
    approval === "confirmed" && approvalHash !== undefined ? approvalHash : null;

  const allowanceStale =
    confirmedApproval !== null && rereadFor !== confirmedApproval;

  /*
   * Masked to null while the re-read is outstanding. `useReadContract` keeps
   * the pre-approval allowance in `data` through a refetch, and handing that
   * to `tradeState` would show an approve step to someone who has just
   * approved.
   */
  const allowance = allowanceStale ? null : (allowanceRead.data ?? null);

  const refetchAllowance = allowanceRead.refetch;

  useEffect(() => {
    if (confirmedApproval === null) return;
    if (rereadFor === confirmedApproval) return;

    let cancelled = false;

    void (async () => {
      await refetchAllowance();
      if (cancelled) return;
      setRereadFor(confirmedApproval);
    })();

    return () => {
      cancelled = true;
    };
  }, [confirmedApproval, rereadFor, refetchAllowance]);

  /*
   * The amount under discussion. `engaged` is the quote's `tokenIn` as it was
   * when a flow committed to it, so a receipt for a settled sale does not
   * vanish because someone touched the input afterwards.
   */
  const amountIn = quote?.tokenIn ?? engaged;

  const state =
    amountIn === null
      ? null
      : tradeState({
          wallet,
          allowance,
          amountIn,
          balance,
          building,
          approval,
          swap,
          quoteExpired,
        });

  /*
   * The floor the browser sends and the floor the calldata carries, both in
   * USDC base units: before a build, the quote's own output less the
   * tolerance; after, the encoded figure.
   */
  const quoteFloor =
    quote === null ? null : minAmountOutFor(quote.usdcOut, SLIPPAGE_BPS);
  const minAmountOut = built?.minAmountOut ?? quoteFloor;

  const repriced = repricedFrom !== null;

  const awaitingReprice =
    repricedFrom !== null &&
    quote !== null &&
    quote.receivedAtMs === repricedFrom;

  const resetFlow = useCallback(() => {
    flow.current += 1;
    resetApproval();
    resetSwap();
    setBuilding(false);
    setBuilt(null);
    setFault(null);
    setEngaged(null);
    setRepricedFrom(null);
    setRereadFor(null);
  }, [resetApproval, resetSwap]);

  /** The account the state below belongs to. See the effect. */
  const settled = useRef<Address | null>(null);

  /*
   * A different account is a different sale. The calldata delivers proceeds
   * to the account it was built for; sending a build across a switch would
   * spend the new account's stock and pay the old one.
   */
  useEffect(() => {
    if (settled.current === sender) return;
    settled.current = sender;
    resetFlow();
  }, [sender, resetFlow]);

  const runBuild = useCallback(
    async (current: SellQuote, recipient: Address) => {
      const floor = minAmountOutFor(current.usdcOut, SLIPPAGE_BPS);

      if (floor === null || floor <= 0n) {
        setFault({
          kind: "build-failed",
          detail: `no floor could be derived from ${current.usdcOut} USDC units`,
        });
        return;
      }

      const ticket = flow.current;

      setFault(null);
      setBuilt(null);
      setRepricedFrom(null);
      setEngaged(current.tokenIn);
      setBuilding(true);

      const outcome = await fetchSellBuild(current, recipient, floor);

      if (ticket !== flow.current) return;

      setBuilding(false);

      if (outcome.kind === "price-moved") {
        setRepricedFrom(current.receivedAtMs);
        refreshQuote();
        return;
      }

      if (outcome.kind === "no-route") {
        setFault({ kind: "no-route", detail: "no route at this size" });
        return;
      }

      if (outcome.kind === "unsafe") {
        setFault({ kind: "unsafe-build", detail: outcome.detail });
        return;
      }

      if (outcome.kind === "failed") {
        setFault({ kind: "build-failed", detail: outcome.detail });
        return;
      }

      setBuilt(outcome.transaction);

      /*
       * THE PIN AND THE ZERO ARE LITERALS HERE, not fields of the payload —
       * the buy path's argument, unchanged: there is no path at all by which
       * a response body reaches either argument. `gas` is deliberately not
       * passed, for the buy path's reason: a limit set too low reverts and
       * costs the user the fee for nothing.
       */
      send({
        to: KYBERSWAP_ROUTER_ADDRESS,
        data: outcome.transaction.data,
        value: 0n,
        chainId: BASE_CHAIN_ID,
      });
    },
    [refreshQuote, send],
  );

  /**
   * The primary button: approve, or build and send. The wallet gate, the
   * expiry, the pending reads, the stock balance and every failure are
   * `tradeState`'s answers — this reads its answer rather than re-asking.
   */
  const submit = useCallback(() => {
    if (state === null || quote === null || sender === null) return;
    if (awaitingReprice) return;

    /*
     * The clock, re-read at the moment of the press: `useSellQuote` ticks
     * once a second, so a quote can be up to a second past expiry while the
     * panel still reads `ready`.
     */
    if (isQuoteExpired(quote, Date.now())) {
      refreshQuote();
      return;
    }

    if (state.kind === "needs-approval") {
      setEngaged(quote.tokenIn);
      resetApproval();
      setRereadFor(null);
      approve({
        address: TOKEN_ADDRESSES[quote.symbol],
        abi: tokenAllowanceAbi,
        functionName: "approve",
        // The exact amount, and the pinned spender. Never unlimited: that is
        // a standing permission over this person's stock, and the panel
        // promises them the opposite in as many words.
        args: [KYBERSWAP_ROUTER_ADDRESS, state.required],
        chainId: BASE_CHAIN_ID,
      });
      return;
    }

    if (state.kind === "ready") {
      void runBuild(quote, sender);
    }
  }, [
    approve,
    awaitingReprice,
    quote,
    refreshQuote,
    resetApproval,
    runBuild,
    sender,
    state,
  ]);

  /**
   * Clear the attempt and ask for a fresh price. `resetFlow` on its own does
   * not re-quote — it runs on mount and on every account change, and a
   * request fired from there would be one nobody asked for.
   */
  const retry = useCallback(() => {
    resetFlow();
    refreshQuote();
  }, [refreshQuote, resetFlow]);

  return {
    state,
    minAmountOut,
    approvalHash: approvalHash ?? null,
    swapHash: swapHash ?? null,
    fault,
    repriced,
    awaitingReprice,
    submit,
    retry,
  };
}

/** What one `/api/sell` request can come back as. */
type SellBuildOutcome =
  | { kind: "transaction"; transaction: ParsedSellSwap }
  /** 409. The price moved; the answer is a new quote, not a second attempt. */
  | { kind: "price-moved" }
  /** 422. Well formed, and no route at this size right now. */
  | { kind: "no-route" }
  /** The payload disagreed with something we pinned. Terminal. */
  | { kind: "unsafe"; detail: string }
  /** Anything else: a 400, a 502, a network failure, an unreadable body. */
  | { kind: "failed"; detail: string };

/**
 * Asks our own route for sell calldata. Never throws.
 *
 * Dispatched on the status code rather than on the body's `kind`: a 409 has
 * to mean re-quote before anything in the payload is read. Four fields go
 * out and no fifth — no `recipient` (the server sets it from the sender) and
 * no token address (the server resolves the symbol against its own
 * registry).
 */
async function fetchSellBuild(
  quote: SellQuote,
  sender: Address,
  minAmountOut: bigint,
): Promise<SellBuildOutcome> {
  let response: Response;

  try {
    response = await fetch("/api/sell", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        symbol: quote.symbol,
        // Decimal strings, both. A JSON number would quietly lose precision
        // on the two values that decide what leaves and whether the swap
        // reverts.
        amountIn: quote.tokenIn.toString(),
        sender,
        minAmountOut: minAmountOut.toString(),
      }),
      cache: "no-store",
    });
  } catch (cause) {
    return {
      kind: "failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (response.status === 409) return { kind: "price-moved" };
  if (response.status === 422) return { kind: "no-route" };

  if (!response.ok) return { kind: "failed", detail: `HTTP ${response.status}` };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "failed",
      detail: `HTTP ${response.status}, unreadable body`,
    };
  }

  const parsed = parseSellSwapWire(body);

  if (parsed.kind === "transaction") return parsed;
  if (parsed.kind === "unsafe") return { kind: "unsafe", detail: parsed.detail };

  return { kind: "failed", detail: parsed.detail };
}
