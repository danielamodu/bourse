import { isUserRejection, type WalletState } from "@/lib/wallet-state";

/**
 * What the trade panel should say, as a pure function of what is known.
 *
 * A sibling of `lib/wallet-state.ts` and the same kind of thing: the whole of the
 * decision, with no React, no wagmi and no `window` in it. `walletState` answers
 * "can this person trade at all"; this answers "what happens if they press the
 * button now", which is a longer question because a buy is two transactions and
 * either of them can be declined, revert, or still be in the mempool.
 *
 * It decides nothing about money. Amounts, floors and calldata come from
 * `lib/build.ts`; this reads a flag and an allowance and picks a state.
 *
 * Two functions, and {@link txPhase} is the smaller one: it turns what wagmi reports
 * about a single transaction into one of seven phases, and {@link tradeState} turns
 * two of those phases plus the wallet, the allowance and the quote into the sentence
 * on screen. Both are here rather than in the hook so that `npm test` covers the
 * whole decision — there is no jsdom in this repo, so logic left in a hook has no
 * offline coverage at all.
 *
 * THE ALLOWANCE IS THE ONLY THING THAT DECIDES `needs-approval`. Not "did we just
 * approve", not "did the approval receipt come back successful" — the allowance
 * read. A confirmed approval whose allowance has not been read back yet lands on
 * `checking-allowance`, deliberately: `approve` can be front-run to zero, a wallet
 * can approve a different amount than it was asked for, and a swap sent against an
 * allowance we assumed rather than read reverts and costs the user gas. Waiting one
 * read is cheap; the alternative is a failed transaction.
 */

/** The two transactions a buy is made of. Carried on every failure state. */
export type TradeStep = "approval" | "swap";

/**
 * Where one transaction has got to.
 *
 * `rejected` is the user declining in their wallet, `reverted` is a receipt that
 * came back failed, and `failed` is everything else — an RPC that would not take
 * the transaction, a signature that never came back. Three states rather than one
 * because the copy differs: one is a choice, one is a chain outcome, and one is
 * ours to apologise for.
 */
export type TxPhase =
  | "idle"
  | "signing"
  | "confirming"
  | "confirmed"
  | "reverted"
  | "rejected"
  | "failed";

export type TradeInput = {
  /** From `walletState`. Anything but `ready` blocks. */
  wallet: WalletState;
  /**
   * USDC the router is already allowed to spend for this sender, in base units.
   * Null until the read lands — never treated as zero, which would show an approve
   * step to someone who has already approved.
   */
  allowance: bigint | null;
  /**
   * Base units the swap spends, in the input token's own decimals: the quote's
   * own `usdcIn` on a buy, the sell quote's `tokenIn` on a sell.
   *
   * Positive by construction. This module is only asked what to render once there
   * is a quote on screen, and a quote exists only for an amount inside the band
   * the route's own params enforce.
   */
  amountIn: bigint;
  /**
   * Balance of the token being spent, in that token's own units — or null
   * where the flow does not judge it.
   *
   * The buy flow passes null: its USDC gate is `walletState`'s `no-usdc`,
   * which owns that sentence and its action, and a second balance check here
   * would be a second copy of it. The sell flow passes the stock balance,
   * because no wallet state knows per-token holdings and an approval that
   * cannot settle is gas for nothing. Null means "not judged here", never
   * "zero" — an unread balance must not read as an empty wallet.
   */
  balance: bigint | null;
  /** Whether a `/api/build` request is in flight. */
  building: boolean;
  /** The approval transaction. `idle` before one is sent. */
  approval: TxPhase;
  /** The swap transaction. `idle` before one is sent. */
  swap: TxPhase;
  /**
   * Whether the quote on screen has passed its expiry.
   *
   * A boolean rather than a clock, so this function stays pure and the panel owns
   * the tick. `isQuoteExpired` in `lib/quote.ts` is what produces it.
   */
  quoteExpired: boolean;
};

export type TradeState =
  /**
   * The wallet is not in a state to trade. Carries `walletState`'s own kind rather
   * than restating it, so the panel reads one union for nine wallet situations and
   * there is no second copy of that copy to keep in step.
   */
  | { kind: "blocked"; wallet: WalletState["kind"] }
  /** The quote on screen is stale. Nothing may be signed against it. */
  | { kind: "quote-expired" }
  /**
   * The wallet holds less of the input token than the trade spends. The
   * button names the shortfall and stays disabled; there is no action that
   * fixes it on this screen, because funding a stock balance happens by
   * buying, not by pressing.
   */
  | { kind: "insufficient-balance" }
  /** Connected and quoted, allowance not read yet. Neither approved nor not. */
  | { kind: "checking-allowance" }
  /**
   * The router may not spend this much yet. `required` is the figure the approval
   * has to cover, carried so the copy can name it without re-deriving it.
   */
  | { kind: "needs-approval"; required: bigint }
  /** The approval is in the wallet, waiting to be signed. */
  | { kind: "approving" }
  /** The approval is signed and in the mempool. */
  | { kind: "approval-confirming" }
  /** Approved and quoted. The buy action is live. */
  | { kind: "ready" }
  /** Fetching calldata. No signature has been asked for yet. */
  | { kind: "building" }
  /** The swap is in the wallet, waiting to be signed. */
  | { kind: "signing" }
  /** The swap is signed and in the mempool. */
  | { kind: "confirming" }
  /** The swap settled. The shares are in the wallet. */
  | { kind: "confirmed" }
  /** A transaction was mined and failed. */
  | { kind: "reverted"; step: TradeStep }
  /** The user declined in their wallet. A choice, not an error. */
  | { kind: "rejected"; step: TradeStep }
  /** Something else went wrong with a transaction. */
  | { kind: "failed"; step: TradeStep };

/**
 * The one rule that decides which of the fourteen the user sees.
 *
 * ORDER IS THE DESIGN, and the reasoning is per step rather than general. It is all
 * one idea: the further a transaction has got, the less anything else on screen is
 * entitled to describe it.
 *
 * 1. A SWAP THAT HAS AN OUTCOME OUTRANKS EVERYTHING. This is the load-bearing one.
 *    A settled buy spends the allowance it needed and outlives the quote it was
 *    built from, so by the time a receipt lands, `allowance < amountIn` is true
 *    again and `quoteExpired` is seconds away. Every check below would give a
 *    confident wrong answer — "approve your USDC" over a trade that has already
 *    happened. The receipt is the screen.
 * 2. A SWAP IN FLIGHT, for the weaker version of the same reason: it cannot be
 *    un-sent. A swap signed with five seconds left on a quote crosses the expiry
 *    while it confirms, and flipping the panel to "quote expired" over a
 *    transaction in the mempool would be false, and would read as a loss.
 * 3. THEN THE WALLET. Everything below assumes a connected wallet on Base with
 *    balances read, which is what `walletState` establishes. Below the swap states,
 *    because a wallet disconnecting does not un-send a transaction and the receipt
 *    still lands; above everything else, because nothing else is actionable.
 * 4. AN APPROVAL THAT FAILED, before the quote. A declined or reverted approval is
 *    something the user just did and has to be told about; an expired quote is a
 *    number that refreshes itself on a timer.
 * 5. AN APPROVAL IN FLIGHT, also before the quote, and not the same rule as 7. An
 *    allowance is not priced — it is permission for an amount — so a quote going
 *    stale under a pending approval invalidates nothing about it. The panel
 *    re-quotes underneath and lands on `ready`.
 * 6. A BUILD IN FLIGHT, before the quote, because `/api/build` fetches its own
 *    fresh route and checks it against the floor we showed. The screen's quote
 *    ageing out mid-build is the case that endpoint exists to handle, not a reason
 *    to abandon the request.
 * 7. AN EXPIRED QUOTE OUTRANKS `needs-approval`, and the reason is gas: an approval
 *    sent against a stale quote is a real transaction with a real fee, and the
 *    amount it authorises was computed from a price that no longer holds. Re-quote
 *    first, then approve once, for the right number.
 * 8. THE ALLOWANCE READ BEFORE THE ALLOWANCE. A pending read is null, and null read
 *    as zero shows an approve step to someone who has already approved — who would
 *    then pay for a second one.
  * 9. Then the allowance itself, which is the whole of the approve decision.
  *
  * 10. THE INPUT BALANCE sits between the expired quote and the allowance
  *  read, and only where a flow supplies it. Below expiry because a stale
  *  number refreshes itself while a shortfall does not move; above the
  *  allowance because permission for funds that are not there is gas for
  *  nothing. The buy flow supplies null and is unaffected — its USDC gate is
  *  `walletState`, which keeps that sentence.
  */
export function tradeState({
  wallet,
  allowance,
  amountIn,
  balance,
  building,
  approval,
  swap,
  quoteExpired,
}: TradeInput): TradeState {
  if (swap === "confirmed") return { kind: "confirmed" };

  const swapFailure = failureOf(swap, "swap");
  if (swapFailure !== null) return swapFailure;

  if (swap === "signing") return { kind: "signing" };
  if (swap === "confirming") return { kind: "confirming" };

  if (wallet.kind !== "ready") return { kind: "blocked", wallet: wallet.kind };

  const approvalFailure = failureOf(approval, "approval");
  if (approvalFailure !== null) return approvalFailure;

  if (approval === "signing") return { kind: "approving" };
  if (approval === "confirming") return { kind: "approval-confirming" };

  if (building) return { kind: "building" };
  if (quoteExpired) return { kind: "quote-expired" };

  /*
   * The input funds, before the permission for them. An approval signed for
   * a trade that cannot settle is a real transaction with a real fee and
   * nothing to show for it, so the shortfall outranks the approve step. It
   * sits below the in-flight states above — money already in motion is still
   * described as in motion — and below an expired quote, which refreshes
   * itself on a timer while a shortfall does not. Null balance is not judged:
   * the buy flow leaves it null and its wallet gate owns that sentence.
   */
  if (balance !== null && balance < amountIn) {
    return { kind: "insufficient-balance" };
  }

  if (allowance === null) return { kind: "checking-allowance" };

  // A `confirmed` approval reaches this line rather than skipping it, and that is
  // the point of the module note: what decides the approve step is what the router
  // may spend now, not what a receipt said a moment ago.
  if (allowance < amountIn) {
    return { kind: "needs-approval", required: amountIn };
  }

  return { kind: "ready" };
}

/**
 * The three ways a transaction ends badly, as a state. Null for everything else,
 * `confirmed` included — success means a different thing for each of the two
 * transactions, so each caller decides its own.
 */
function failureOf(phase: TxPhase, step: TradeStep): TradeState | null {
  if (phase === "rejected") return { kind: "rejected", step };
  if (phase === "reverted") return { kind: "reverted", step };
  if (phase === "failed") return { kind: "failed", step };

  return null;
}

/**
 * What wagmi knows about one transaction, reduced to the four things that decide
 * its phase.
 *
 * A shape rather than the hooks themselves, so {@link txPhase} is pure and covered
 * offline. `hooks/useTrade.ts` fills it from `useWriteContract` /
 * `useSendTransaction` and `useWaitForTransactionReceipt`; nothing else does.
 */
export type TxSignal = {
  /** A signature has been asked for and not yet answered. wagmi's `isPending`. */
  signing: boolean;
  /** The hash the wallet handed back, or null before there is one. */
  hash: string | null;
  /** Whatever asking for the signature threw. Null when it did not. */
  writeError: unknown;
  /**
   * The receipt's own `status`, or null until a receipt lands.
   *
   * `"reverted"` is the case this whole type exists for: the transaction was mined,
   * the user paid for it, and it did nothing.
   */
  receipt: "success" | "reverted" | null;
  /** Whatever waiting for the receipt threw. Null when it did not. */
  receiptError: unknown;
};

/**
 * One transaction's phase, from what wagmi reports about it.
 *
 * ORDER IS THE DESIGN here too, and it is one idea: THE CHAIN'S ANSWER OUTRANKS
 * OURS. A mined receipt is the last word on what happened to someone's money, so it
 * is read first and a `"reverted"` receipt can never be reported as anything else.
 *
 * 1. A REVERTED RECEIPT IS A FAILURE. The transaction landed, the gas is spent, and
 *    nothing was bought. It is the outcome most likely to be misread as success by
 *    code that only checks whether a receipt arrived, which is why it is the first
 *    line rather than a branch further down.
 * 2. Then success, for the same reason from the other side.
 * 3. A RECEIPT WE COULD NOT FETCH IS `failed`, NOT A REVERT. We do not know what
 *    happened — the transaction may well have settled — so the copy has to send the
 *    user to Basescan rather than tell them it failed on chain.
 * 4. Then the write itself, split by {@link isUserRejection}: declining in a wallet
 *    is a choice and gets no banner, anything else is ours to explain. Reusing that
 *    function rather than duck-typing a second time is deliberate — one rejection
 *    test for the whole app, already covered by `lib/wallet-state.test.ts`.
 * 5. A hash with no receipt yet is in the mempool.
 * 6. And a pending signature with no hash is still in the wallet.
 */
export function txPhase({
  signing,
  hash,
  writeError,
  receipt,
  receiptError,
}: TxSignal): TxPhase {
  if (receipt === "reverted") return "reverted";
  if (receipt === "success") return "confirmed";
  if (receiptError !== null && receiptError !== undefined) return "failed";

  if (writeError !== null && writeError !== undefined) {
    return isUserRejection(writeError) ? "rejected" : "failed";
  }

  if (hash !== null) return "confirming";
  if (signing) return "signing";

  return "idle";
}
