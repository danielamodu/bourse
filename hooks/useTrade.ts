"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import {
  useReadContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { usdcAbi } from "@/lib/abi";
import { parseAddress } from "@/lib/address";
import {
  SLIPPAGE_BPS,
  minAmountOutFor,
  parseSwapWire,
  type ParsedSwap,
} from "@/lib/build";
import {
  KYBERSWAP_ROUTER_ADDRESS,
  isQuoteExpired,
  type Quote,
} from "@/lib/quote";
import { BASE_CHAIN_ID } from "@/lib/rpc";
import { USDC_ADDRESS } from "@/lib/tokens";
import {
  tradeState,
  txPhase,
  type TradeState,
  type TxPhase,
} from "@/lib/trade-state";
import type { WalletState } from "@/lib/wallet-state";

/**
 * The buy, as far as the browser is involved in it.
 *
 * The only place in Bourse that asks a wallet for a signature, and the only place
 * a user's USDC moves. `useWallet` is the read-only sibling: it establishes that
 * someone *can* trade. This asks the wallet to do it.
 *
 * IT DECIDES NOTHING ABOUT WHAT THE PANEL SAYS. Every result gathered here — the
 * allowance, two mutations, two receipts, a build request — is fed to `tradeState`
 * in `lib/trade-state.ts`, which is the one function that turns them into a state.
 * The same arrangement as `useWallet` delegating to `walletState`, and for the
 * same reason: there is no jsdom in this repo, so a decision made inside a hook
 * has no offline coverage at all. If a branch here looks like it is choosing what
 * to render, it is a bug.
 *
 * FAIL-CLOSED, and the list is short because most of it is structural rather than
 * checked at runtime:
 *
 * - The approval's spender is {@link KYBERSWAP_ROUTER_ADDRESS}, imported. No field
 *   of any response reaches that argument.
 * - The swap's `to` is that same constant and its `value` is `0n`, both written as
 *   literals at the send site. `parseSwapWire` has already refused the payload if
 *   it named anything else — the browser is the last place `to` is used, so it is
 *   the last place it is checked, and a tampered response, a stale service worker
 *   or a compromised asset host all land exactly here.
 * - The approval is for the exact amount, never unlimited. That is why a purchase
 *   takes two signatures, and why the panel says so before the first one.
 * - After an approval confirms, the allowance is read again. A successful receipt
 *   is not treated as proof of an allowance; see the note in `lib/trade-state.ts`.
 * - A build that came back unsafe is terminal. `unsafe-build` gets no retry,
 *   because a payload that disagreed with the pin will disagree again.
 */

/**
 * Why a build did not produce a transaction.
 *
 * Not a state. {@link TradeState} already has `failed`, and a second vocabulary for
 * the same screen is how two sources of truth start. This annotates that state so
 * the copy can say which step went wrong and whether trying again is worth
 * anything.
 */
export type TradeFault = {
  kind:
    /** The payload disagreed with something we pinned. Terminal: no retry. */
    | "unsafe-build"
    /** No route at this size, right now. A market condition, not a fault. */
    | "no-route"
    /** Everything else that stopped a build. Retryable. */
    | "build-failed";
  /**
   * For the log, and for copy that needs to be specific. Ours rather than the
   * aggregator's: `/api/build` never forwards upstream text across the boundary.
   */
  detail: string;
};

export type UseTradeInput = {
  /**
   * The quote on screen, from `useQuote`. Null when there is nothing to buy: before
   * an amount is typed, between amounts, or after a refetch that failed.
   */
  quote: Quote | null;
  /** `useQuote`'s own expiry flag, so one clock ticks for the whole panel. */
  quoteExpired: boolean;
  /** `useQuote`'s `refresh`. Called on a 409 and by {@link UseTradeResult.retry}. */
  refreshQuote: () => void;
  /** From `useWallet`. Anything but `ready` blocks, and `tradeState` decides that. */
  wallet: WalletState;
  /**
   * The connected address as `useWallet` reports it. Canonicalised here with
   * `parseAddress`, because it is both the allowance's owner and — via
   * `/api/build`'s `recipient` — the account every share bought lands in.
   */
  owner: string | null;
};

export type UseTradeResult = {
  /**
   * What to render, from `tradeState`. Null only when there is no amount to talk
   * about: no quote, and no flow already under way for one.
   */
  state: TradeState | null;
  /**
   * The floor, in the token's base units: the fewest units this trade can settle
   * for. The built figure once a build has landed, because that is the number the
   * calldata enforces, and the quote's own floor before that, because that is what
   * the user is being asked to agree to. Null with no quote.
   */
  minAmountOut: bigint | null;
  /** The approval's hash, for a Basescan link. Null before one is sent. */
  approvalHash: string | null;
  /** The swap's hash, for the same reason. */
  swapHash: string | null;
  /** Why a `failed` state happened, when a build is the reason. */
  fault: TradeFault | null;
  /**
   * The price moved between the quote shown and the route built, so the quote has
   * been refreshed. The panel names the new figure and waits for another press:
   * nothing is submitted at a price the user has not seen.
   */
  repriced: boolean;
  /**
   * The quote on screen is the one a build just refused, and its replacement has not
   * landed yet. Nothing can be submitted in that window — there is no new number to
   * agree to — so the panel holds its action rather than offering a press that would
   * do nothing.
   */
  awaitingReprice: boolean;
  /** The primary button. A no-op in every state that is not an action. */
  submit: () => void;
  /** Clear a finished or failed attempt and quote again. */
  retry: () => void;
};

export function useTrade({
  quote,
  quoteExpired,
  refreshQuote,
  wallet,
  owner,
}: UseTradeInput): UseTradeResult {
  const sender = useMemo(() => parseAddress(owner), [owner]);

  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState<ParsedSwap | null>(null);
  const [fault, setFault] = useState<TradeFault | null>(null);
  const [engaged, setEngaged] = useState<bigint | null>(null);
  const [repricedFrom, setRepricedFrom] = useState<number | null>(null);
  const [rereadFor, setRereadFor] = useState<string | null>(null);

  /**
   * Bumped by every reset, captured by every build.
   *
   * A build is a network round trip. Pressing "start over" or switching account in
   * the middle of one must not let the response that arrives afterwards send a
   * transaction: the calldata encodes a recipient and an amount that are no longer
   * the ones on screen.
   */
  const flow = useRef(0);

  const allowanceRead = useReadContract({
    address: USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "allowance",
    // The spender is the pinned router, imported. Never an address off a response,
    // and never a token address — this is USDC's own allowance, for the contract
    // that will pull it.
    args:
      sender === null
        ? undefined
        : ([sender, KYBERSWAP_ROUTER_ADDRESS] as const),
    chainId: BASE_CHAIN_ID,
    query: { enabled: sender !== null },
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
   * A build that failed is reported as a swap that failed.
   *
   * Not a fudge: from the user's side one press is one action, and `/api/build` is
   * a step inside it that happens before the wallet opens. Feeding it in here
   * rather than adding a fifteenth state keeps `tradeState` the only thing that
   * decides what the panel says, and `fault` is what tells the copy which step it
   * was. Guarded on `idle` so a fault left behind can never describe a transaction
   * that is actually in flight.
   */
  const swap: TxPhase = fault !== null && sent === "idle" ? "failed" : sent;

  /**
   * The approval hash whose allowance has not been read back yet, or null.
   *
   * `approval === "confirmed"` means a receipt came back successful, which is not
   * the same as knowing what the router may now spend: `approve` can be front-run
   * to zero, and a wallet can approve a different amount than it was asked for.
   */
  const confirmedApproval =
    approval === "confirmed" && approvalHash !== undefined ? approvalHash : null;

  const allowanceStale =
    confirmedApproval !== null && rereadFor !== confirmedApproval;

  /*
   * Masked to null while that re-read is outstanding, which is the whole point of
   * it. `useReadContract` keeps the previous value in `data` through a refetch, and
   * the previous value here is the pre-approval allowance — handing that to
   * `tradeState` would show an approve step to someone who has just approved, who
   * would then pay for a second one. Null lands on `checking-allowance`, which is
   * the true statement about that moment.
   */
  const allowance = allowanceStale ? null : (allowanceRead.data ?? null);

  const refetchAllowance = allowanceRead.refetch;

  useEffect(() => {
    if (confirmedApproval === null) return;
    // Idempotence, and the reason `rereadFor` is set after the await rather than
    // before it: marking the hash first would race the read it is meant to record.
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
   * The amount under discussion.
   *
   * `engaged` is the quote's `usdcIn` as it was when a flow committed to it, and it
   * is the fallback for one reason: `useQuote` drops its quote the moment the typed
   * amount changes, and a receipt for a trade that has already settled must not
   * vanish because someone touched the input afterwards.
   */
  const amountIn = quote?.usdcIn ?? engaged;

  const state =
    amountIn === null
      ? null
      : tradeState({
          wallet,
          allowance,
          amountIn,
          building,
          approval,
          swap,
          quoteExpired,
        });

  /*
   * The floor the browser sends and the floor the calldata carries.
   *
   * Before a build, the quote's own output less the tolerance: the number the user
   * is agreeing to, and the one `/api/build` measures its fresh route against.
   * After a build, the encoded figure, because that is what the transaction
   * actually enforces. They are allowed to differ — the server derives the encoded
   * floor from the route it just fetched, so an ordinary adverse tick moves it, and
   * `parseSwapWire` deliberately does not compare the two.
   */
  const quoteFloor =
    quote === null ? null : minAmountOutFor(quote.unitsOut, SLIPPAGE_BPS);
  const minAmountOut = built?.minAmountOut ?? quoteFloor;

  const repriced = repricedFrom !== null;

  /*
   * The refused quote is still the one on screen, so there is nothing new to agree
   * to yet. This gates `submit` rather than disabling the button, because the panel
   * is already showing the old figure beside a line saying the price moved.
   */
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
   * A different account is a different trade.
   *
   * `/api/build` sets `recipient` to the sender, so calldata built for one wallet
   * delivers shares to that wallet whoever signs it — sending a build across an
   * account switch would spend the new account's USDC and hand the stock to the old
   * one. The hashes go with it: a receipt shown under the wrong account is a claim
   * about money that is not theirs.
   *
   * Compared against a ref rather than run on every change of `resetFlow`, whose
   * identity depends on two functions this file does not own. A reset that fired on
   * every render would clear a build in flight.
   */
  useEffect(() => {
    if (settled.current === sender) return;
    settled.current = sender;
    resetFlow();
  }, [sender, resetFlow]);

  const runBuild = useCallback(
    async (current: Quote, recipient: Address) => {
      const floor = minAmountOutFor(current.unitsOut, SLIPPAGE_BPS);

      // Unreachable from a real quote — `unitsOut` is positive on anything that
      // became one — and handled rather than asserted because the alternative on
      // this path is posting a request with no floor in it.
      if (floor === null || floor <= 0n) {
        setFault({
          kind: "build-failed",
          detail: `no floor could be derived from ${current.unitsOut} units`,
        });
        return;
      }

      const ticket = flow.current;

      setFault(null);
      setBuilt(null);
      setRepricedFrom(null);
      setEngaged(current.usdcIn);
      setBuilding(true);

      const outcome = await fetchBuild(current, recipient, floor);

      // A reset, an account switch, or a fresh flow started while this was in the
      // air. The calldata describes a trade that is no longer the one on screen.
      if (ticket !== flow.current) return;

      setBuilding(false);

      if (outcome.kind === "price-moved") {
        // Not an error and not a retry. Quote again, show the new number, and wait
        // for the user to agree to that one.
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
       * THE PIN AND THE ZERO ARE LITERALS HERE, not fields of the payload.
       *
       * `parseSwapWire` has already refused a payload whose `to` was not this
       * address or whose `value` was not the string `"0"`, and that check is what
       * makes reaching this line mean anything. Writing the constants again at the
       * call site is not the same check twice: it means there is no path at all by
       * which a response body reaches either argument, which is a stronger
       * statement than comparing one.
       *
       * `gas` is deliberately not passed. The aggregator's estimate is a figure for
       * the panel; a limit set too low reverts and costs the user the fee for
       * nothing, so the wallet estimates against the state it is about to sign
       * over.
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
   * The primary button, for every state it has anything to do.
   *
   * Two actions and no third: approve, or build and send. The wallet gate, the
   * expiry, the pending reads and every failure are `tradeState`'s answers, and
   * this reads its answer rather than re-asking the questions — which is also why
   * a press in any other state does nothing, including a second press during
   * `building`.
   */
  const submit = useCallback(() => {
    if (state === null || quote === null || sender === null) return;
    // The figure on screen is the one that was just refused. Waiting for its
    // replacement is the point; see `awaitingReprice`.
    if (awaitingReprice) return;

    /*
     * The clock, re-read at the moment of the press.
     *
     * `useQuote` ticks once a second, so a quote can be up to a second past its
     * expiry while the panel still reads `ready`. Asking again here costs nothing,
     * and the alternative is a wallet prompt against a price that has gone.
     */
    if (isQuoteExpired(quote, Date.now())) {
      refreshQuote();
      return;
    }

    if (state.kind === "needs-approval") {
      setEngaged(quote.usdcIn);
      // A previous attempt's error would otherwise still be on the mutation, and
      // `txPhase` reads an error over a request that has only just gone out.
      resetApproval();
      setRereadFor(null);
      approve({
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: "approve",
        // The exact amount, and the pinned spender. Not an unlimited allowance:
        // that is a standing permission over this person's USDC, and the panel
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
   * Clear the attempt and ask for a fresh price.
   *
   * The action behind "try again" and behind "buy something else" after a receipt.
   * `resetFlow` on its own deliberately does not re-quote — it runs on mount and on
   * every account change, and a request fired from there would be a request nobody
   * asked for.
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

/** What one `/api/build` request can come back as. */
type BuildOutcome =
  | { kind: "transaction"; transaction: ParsedSwap }
  /** 409. The price moved; the answer is a new quote, not a second attempt. */
  | { kind: "price-moved" }
  /** 422. Well formed, and no route at this size right now. */
  | { kind: "no-route" }
  /** The payload disagreed with something we pinned. Terminal. */
  | { kind: "unsafe"; detail: string }
  /** Anything else: a 400, a 502, a network failure, an unreadable body. */
  | { kind: "failed"; detail: string };

/**
 * Asks our own route for calldata. Never throws.
 *
 * The mirror of `fetchQuote` in `hooks/useQuote.ts`, and it sits in this file for
 * the same reason: it is the network edge, and everything it hands back is decided
 * by `parseSwapWire` in `lib/build.ts`, where the offline suite covers it.
 *
 * Dispatched on the status code rather than on the body's `kind`. The route sets
 * both, and the status is the half that cannot be faked by a body we have not
 * parsed yet — a 409 has to mean re-quote before anything in the payload is read.
 *
 * Four fields go out and no fifth. There is no `recipient`, because `/api/build`
 * sets that from the sender, and no token address, because the server resolves the
 * symbol against its own registry — a counterfeit address cannot be posted to an
 * endpoint that takes no addresses but the wallet's own.
 */
async function fetchBuild(
  quote: Quote,
  sender: Address,
  minAmountOut: bigint,
): Promise<BuildOutcome> {
  let response: Response;

  try {
    response = await fetch("/api/build", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        symbol: quote.symbol,
        // Decimal strings, both. A JSON number would quietly lose precision on the
        // two values that decide how much USDC leaves and whether the swap reverts.
        amountIn: quote.usdcIn.toString(),
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

  const parsed = parseSwapWire(body);

  if (parsed.kind === "transaction") return parsed;
  if (parsed.kind === "unsafe") return { kind: "unsafe", detail: parsed.detail };

  return { kind: "failed", detail: parsed.detail };
}
