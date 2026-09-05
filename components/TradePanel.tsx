"use client";

import type { QuoteStatus, UseQuoteResult } from "@/hooks/useQuote";
import type { TradeFault, UseTradeResult } from "@/hooks/useTrade";
import { cx } from "@/lib/cx";
import {
  formatBourseFee,
  formatFloor,
  formatNGN,
  formatNGNAmount,
  formatPremiumBps,
  formatQuoteCountdown,
  formatShares,
  formatSpread,
  formatUSD,
} from "@/lib/format";
import { floorNgn } from "@/lib/quote-ngn";
import { basescanTxUrl } from "@/lib/rpc";
import type { StockToken } from "@/lib/tokens";
import type { TradeState, TradeStep } from "@/lib/trade-state";
import type { WalletState } from "@/lib/wallet-state";

import styles from "./TradePanel.module.css";

/**
 * The highest-trust component in the app, and now the one that spends money.
 *
 * Everything a person needs in order to judge a purchase is on screen at once and
 * none of it is collapsible: what they pay, what they receive, the least they can
 * receive, the rate, the premium against the reference, what crossing the market
 * costs, the network fee, our own fee, the total, and how long the price is good
 * for. Rows render with a placeholder when there is no quote rather than
 * disappearing, so the shape of the disclosure never changes underneath someone.
 *
 * ONE BUTTON, AND ITS LABEL IS THE STATE. Approve, buy, waiting, confirming, bought,
 * try again — every one of those words comes from `tradeState` in
 * `lib/trade-state.ts` by way of `hooks/useTrade.ts`, and this file chooses none of
 * them. The same arrangement as `WalletConnect` reading `walletState`, and the reason
 * the switches below are exhaustive: a new state cannot ship without words.
 *
 * THE TWO SIGNATURES ARE EXPLAINED BEFORE THE FIRST ONE. A wallet that asks twice
 * reads as a scam to anyone who has been warned about approvals, and the moment the
 * second prompt appears is too late to say so. The approval is for the exact amount,
 * never unlimited, and the copy says so in as many words.
 *
 * THE COST LINES ARE NAMED SEPARATELY AND THE TOTAL IS NOT THEIR SUM. The market
 * spread and the Bourse fee both come *out of* what the user pays; the network fee is
 * paid on top, in ETH. So the total is the amount plus the network fee, and the two
 * lines above it say where the money inside the amount went. Adding all four would
 * double-count — see the diagram in `lib/quote-ngn.ts`.
 *
 * The Bourse fee line renders at every value, including zero, where it reads "None".
 * A fee we do not charge is worth stating: it puts the market spread in context as
 * someone else's cost, and it means the day a fee exists is a change to a line people
 * have always seen rather than a charge that appeared.
 *
 * Presentational, still. Every judgement — whether an amount is quotable, what the
 * floor comes to in shares, whether a receipt reverted, what the button is allowed to
 * do — was made in `hooks/useQuote.ts`, `hooks/useTrade.ts`, `lib/quote-ngn.ts` and
 * `lib/trade-state.ts`. What is here is the sentences.
 */

export type TradePanelProps = {
  token: StockToken;
  /** Raw field text, so a half-typed amount is never reformatted under the user. */
  amount: string;
  onAmountChange: (value: string) => void;
  /** The parsed amount, or null when the field does not hold a usable number. */
  ngn: number | null;
  /** USD to NGN, shown as the conversion rate this quote was priced at. */
  usdToNgnRate: number | null;
  quote: UseQuoteResult;
  /** Age of the Chainlink reference, e.g. `13h old`. Null when unknown. */
  referenceAge: string | null;
  /**
   * The buy itself, from `hooks/useTrade.ts`.
   *
   * Its `state` is null until there is an amount to talk about, which is this panel's
   * read-only mode: rows, a status line, and nothing to press.
   */
  trade: UseTradeResult;
};

export function TradePanel({
  token,
  amount,
  onAmountChange,
  ngn,
  usdToNgnRate,
  quote,
  referenceAge,
  trade,
}: TradePanelProps) {
  const { ngnQuote, status, secondsRemaining } = quote;
  const priced = ngnQuote !== null;

  const { state, fault, repriced } = trade;
  const ngnIn = ngnQuote?.ngnIn ?? null;

  /*
   * The floor, in the two units a person can weigh it in.
   *
   * `token.decimals` is the registry's own figure — 8 on each of the four, read off
   * the contracts by `verify:chain` — never 18 and never the feed's. `minAmountOut`
   * is the built figure once there is one, because that is what the calldata
   * enforces, and the quote's own floor before that.
   */
  const floor = floorNgn(
    trade.minAmountOut,
    token.decimals,
    ngnQuote?.ngnPerShare ?? null,
  );

  const press = action(state, token, ngnIn, trade);
  const note = signatureNote(state, ngnIn);
  const moment = momentCopy(state, fault, repriced);
  const hash = txHash(state, trade.approvalHash, trade.swapHash);
  const tone = momentTone(state, fault, repriced);

  return (
    <section className={styles.panel} aria-labelledby="trade-panel-title">
      <h2 id="trade-panel-title" className={styles.title}>
        Buy {token.name}
      </h2>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="trade-amount">
          You pay
        </label>
        <div className={styles.inputWrap}>
          <span className={styles.currency} aria-hidden="true">
            ₦
          </span>
          <input
            id="trade-amount"
            className={styles.input}
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="50,000"
            aria-describedby="trade-amount-status"
          />
        </div>
      </div>

      <dl className={styles.rows}>
        {/* The quote's own `ngnIn`, not the parsed field, whenever there is a quote:
            every figure below belongs to one quote, and the total is this line plus
            the network fee. Reading the field here would let a half-typed amount sit
            above a total computed from the last priced one. Before any quote there is
            nothing else to show, so the typed amount stands in. */}
        <Row
          label="You pay"
          value={formatNGNAmount(ngnIn ?? ngn)}
          filled={(ngnIn ?? ngn) !== null}
        />

        <Row
          label="You receive (estimate)"
          value={`${formatShares(ngnQuote?.quote.shares ?? null)} ${token.tokenSymbol}`}
          filled={priced}
          caption="Estimated from the quoted route. The exact number is set when the trade goes through."
        />

        {/* Directly under the estimate, because it is the same sentence finished. The
            estimate is what the route says now; this is what the calldata will accept
            at worst, and the pair of them is the whole slippage disclosure. On screen
            rather than behind a tooltip: it is the number that decides whether a
            transaction settles or reverts. */}
        <Row
          label="Least you'll receive"
          value={formatFloor(floor.shares, floor.ngn, token.tokenSymbol)}
          filled={floor.shares !== null}
          caption="If the price moves while your purchase is in flight, this is the fewest shares it can settle for. Below it the purchase does not go through and your naira stays where it is."
        />

        <Row
          label="Price per share"
          value={formatNGNAmount(ngnQuote?.ngnPerShare ?? null)}
          filled={priced}
        />

        <Row
          label="Rate used"
          value={
            usdToNgnRate === null
              ? formatNGNAmount(null)
              : `${formatNGN(1, usdToNgnRate)} per ${formatUSD(1)}`
          }
          filled={usdToNgnRate !== null}
        />

        <Row
          label="Premium vs reference"
          value={formatPremiumBps(ngnQuote?.premiumBps ?? null)}
          filled={ngnQuote !== null && ngnQuote.premiumBps !== null}
          caption={
            referenceAge === null
              ? undefined
              : `Against a Chainlink reading ${referenceAge}. The token itself keeps trading.`
          }
        />

        {/* The cost group. Naira first in the spread, because ₦525 is a figure someone
            can weigh against what they were about to spend and 1.05% is arithmetic they
            have to do first. */}
        <Row
          label="Market spread"
          value={formatSpread(
            ngnQuote?.spreadNgn ?? null,
            ngnQuote?.quote.executionCostBps ?? null,
          )}
          filled={ngnQuote !== null && ngnQuote.quote.executionCostBps !== null}
          variant="group"
          caption="The difference between the pool's price and the reference. It comes out of the amount above, and it is the market's, not ours."
        />

        <Row
          label="Network fee (estimate)"
          value={formatNGNAmount(ngnQuote?.gasNgn ?? null)}
          filled={ngnQuote !== null && ngnQuote.gasNgn !== null}
          caption="Paid to the Base network in ETH, on top of the amount above. Your wallet sets the final figure when you sign."
        />

        {/* Rendered at every value, zero included, where it reads "None". A fee we do
            not charge is worth stating: it puts the market spread above in context as
            someone else's cost, and it means the day a fee exists is a change to a line
            people have always seen rather than a charge that appeared. */}
        <Row
          label="Bourse fee"
          value={formatBourseFee(ngnQuote?.feeNgn ?? null)}
          filled={ngnQuote !== null && ngnQuote.feeNgn !== null}
        />

        {/* The amount plus the network fee, and nothing else. The spread and the Bourse
            fee are already inside the amount, so adding them here would charge the user
            twice for money that never left twice. */}
        <Row
          label="Total"
          value={formatNGNAmount(ngnQuote?.totalNgn ?? null)}
          filled={ngnQuote !== null && ngnQuote.totalNgn !== null}
          variant="total"
        />

        <Row
          label="Quote expires in"
          value={formatQuoteCountdown(secondsRemaining)}
          filled={secondsRemaining !== null}
        />
      </dl>

      {/* Wired to the input by `aria-describedby`, so the reason there is no quote
          reaches a screen reader as a description of the field rather than as text
          somewhere below it. Mounted unconditionally, and empty when there is nothing
          to say: an `aria-live` region that is conditionally rendered announces
          nothing, because it is not in the tree at the moment the message arrives. */}
      <p
        id="trade-amount-status"
        className={cx(styles.status, noticeStatus(status) && styles.statusNotice)}
        aria-live="polite"
      >
        {statusCopy(quote)}
      </p>

      {/* Before the first prompt, never after it. A wallet that asks twice reads as a
          scam to anyone who has been warned about approvals, and by the time the
          second prompt appears it is too late to explain. */}
      {note === null ? null : <p className={styles.signatures}>{note}</p>}

      {/* ONE BUTTON. Its label, and whether it can be pressed at all, come from
          `tradeState` by way of `action` below — this element chooses neither. */}
      {press === null ? null : (
        <button
          type="button"
          className={styles.action}
          onClick={press.press === "submit" ? trade.submit : trade.retry}
          disabled={!press.enabled}
        >
          {press.label}
        </button>
      )}

      {/* What just happened, and the link to check it. Always mounted for the same
          reason as the status line, and collapsed by `.moment:empty` when there is
          nothing to report, so the panel does not carry a gap for it. Colour is never
          the only signal — every tone below arrives with a sentence. */}
      <p
        className={cx(
          styles.moment,
          tone === "notice" && styles.momentNotice,
          tone === "negative" && styles.momentNegative,
          tone === "positive" && styles.momentPositive,
        )}
        aria-live="polite"
      >
        {moment}
        {hash === null ? null : (
          <a
            className={styles.link}
            href={basescanTxUrl(hash)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View this transaction on Basescan
          </a>
        )}
      </p>

      {/* The quote's own retry, and the reason it is gated on `state === null`: past
          that point the primary button above is the one thing to press, and two
          buttons offering to try again would be two answers to one question. */}
      {status === "failed" && state === null ? (
        <button type="button" className={styles.retry} onClick={quote.refresh}>
          Try again
        </button>
      ) : null}

      <p className={styles.disclaimer}>
        These figures come from the route quoted right now. The shares you receive are
        settled on chain when your purchase goes through, and never fewer than the floor
        named above; the network fee is your wallet's to set at the moment you sign. A
        signed purchase cannot be reversed, by us or by anyone.
      </p>
    </section>
  );
}

type RowProps = {
  label: string;
  value: string;
  /** Whether `value` is a real figure rather than a placeholder. */
  filled: boolean;
  caption?: string;
  /** `group` opens the cost block with a rule; `total` closes it in heavier type. */
  variant?: "default" | "group" | "total";
};

/**
 * One disclosure line.
 *
 * A `<div>` wrapping each `<dt>`/`<dd>` pair, which is the grouping element `<dl>`
 * allows and the one screen readers announce as a pair. A row with no figure yet
 * renders its placeholder in muted type rather than disappearing, so the shape of the
 * panel is the same before and after a quote lands — nothing moves under someone who
 * is reading it.
 */
function Row({ label, value, filled, caption, variant = "default" }: RowProps) {
  return (
    <div
      className={cx(
        styles.row,
        variant === "group" && styles.rowGroup,
        variant === "total" && styles.rowTotal,
      )}
    >
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.valueCell}>
        <span className={cx(styles.value, !filled && styles.muted)}>{value}</span>
        {caption === undefined ? null : (
          <span className={styles.caption}>{caption}</span>
        )}
      </dd>
    </div>
  );
}

/**
 * Which quote statuses read as a notice rather than as plain metadata.
 *
 * Amber for the four a person can do something about — an amount outside the band we
 * can price, no route, a request that did not come back — and plain for everything
 * else, `loading` included. Tinting "getting a price" would make the ordinary case
 * look like a problem.
 */
function noticeStatus(status: QuoteStatus): boolean {
  return (
    status === "too-small" ||
    status === "too-large" ||
    status === "no-liquidity" ||
    status === "failed"
  );
}

/**
 * The line under the amount field, exhaustive over `QuoteStatus`.
 *
 * It describes the *price*, never the purchase: what happens after a press is the
 * trade moment's job further down, and two regions narrating one action would talk
 * over each other. Named amounts come from `useQuote`'s own band, so the figure quoted
 * here is the figure the route will accept.
 */
function statusCopy({
  status,
  minNgn,
  maxNgn,
  expired,
}: UseQuoteResult): string {
  switch (status) {
    case "idle":
      return "Enter an amount to see what it buys.";
    case "unquotable":
      return "This stock is issued on Base but has no pool yet, so it cannot be bought here.";
    case "too-small":
      return minNgn === null
        ? "That is less than we can price."
        : `The smallest amount we can price is ${formatNGNAmount(minNgn)}.`;
    case "too-large":
      return maxNgn === null
        ? "That is more than we can price."
        : `The largest amount we can price is ${formatNGNAmount(maxNgn)}.`;
    case "loading":
      return "Getting a price.";
    case "quote":
      // Never blank: this element is wired to the input by `aria-describedby`, and a
      // described field whose description empties has nothing to announce.
      return expired
        ? "Getting a fresh price."
        : "This price is current. It refreshes on its own when it runs out.";
    case "no-liquidity":
      return "There is no route for this amount right now. A smaller amount may still go through.";
    case "failed":
      return "We could not get a price just now.";
  }
}

type Action = {
  label: string;
  /** False for a state that is something happening rather than something to do. */
  enabled: boolean;
  /** Which of the hook's two callbacks a press runs. */
  press: "submit" | "start-over";
};

/**
 * The one button, or null when there is nothing to press.
 *
 * EVERY LABEL COMES FROM THE STATE, and the labels are all different — a disabled
 * button wearing the same words as the live one reads as a dead control, so waiting
 * states say what is being waited for. `enabled` and the label are decided together
 * here for that reason.
 *
 * Null in exactly two situations. Before there is an amount to talk about, and after
 * an unsafe build: a payload that disagreed with the pinned router will disagree
 * again, so offering "try again" over it would invite someone to keep pressing at a
 * refusal that is doing its job. `blocked` is *not* one of them — the button stays on
 * screen naming what is missing, and the wallet panel underneath carries the control
 * that fixes it.
 */
function action(
  state: TradeState | null,
  token: StockToken,
  ngnIn: number | null,
  trade: UseTradeResult,
): Action | null {
  if (state === null) return null;

  switch (state.kind) {
    case "blocked":
      return {
        label: blockedLabel(state.wallet),
        enabled: false,
        press: "submit",
      };
    case "quote-expired":
      return { label: "Get a new price", enabled: true, press: "submit" };
    case "checking-allowance":
      return { label: "Checking your permission", enabled: false, press: "submit" };
    case "needs-approval":
      return {
        // The naira figure, not the USDC one. It is the same amount, and it is the
        // number they typed.
        label:
          ngnIn === null
            ? "Approve this amount"
            : `Approve ${formatNGNAmount(ngnIn)}`,
        enabled: true,
        press: "submit",
      };
    case "approving":
      return { label: "Approve it in your wallet", enabled: false, press: "submit" };
    case "approval-confirming":
      return { label: "Recording your permission", enabled: false, press: "submit" };
    case "ready":
      /*
       * Three labels for one state, and the middle one is why `awaitingReprice`
       * exists. Between a build refusing a stale price and its replacement landing,
       * the figures on screen are the refused ones — a press would do nothing, so the
       * button says what it is waiting for instead of looking broken.
       */
      if (trade.awaitingReprice) {
        return { label: "Getting the new price", enabled: false, press: "submit" };
      }
      return trade.repriced
        ? { label: "Buy at this new price", enabled: true, press: "submit" }
        : { label: `Buy ${token.tokenSymbol}`, enabled: true, press: "submit" };
    case "building":
      return { label: "Getting the final price", enabled: false, press: "submit" };
    case "signing":
      return {
        label: "Confirm the purchase in your wallet",
        enabled: false,
        press: "submit",
      };
    case "confirming":
      return { label: "Your purchase is going through", enabled: false, press: "submit" };
    case "confirmed":
      return { label: "Buy again", enabled: true, press: "start-over" };
    case "rejected":
      // `submit` would be a no-op: the write still carries the rejection, so the state
      // stays `rejected` until the flow is cleared. "Start over" is what clears it.
      return { label: "Try again", enabled: true, press: "start-over" };
    case "reverted":
      return {
        label: "Try again with a new price",
        enabled: true,
        press: "start-over",
      };
    case "failed":
      // The one terminal case in the whole panel.
      if (trade.fault?.kind === "unsafe-build") return null;
      return { label: "Try again", enabled: true, press: "start-over" };
  }
}

/**
 * What the button says while the wallet is the thing in the way.
 *
 * Disabled in every case, and naming the blocker rather than saying "Buy" in grey: the
 * panel underneath carries the one control that fixes it, and a button that names the
 * problem points at that control instead of competing with it. This is the only place
 * the trade panel says anything about a wallet — the sentences belong to
 * `WalletConnect`, and repeating them here would be a second copy to keep in step.
 */
function blockedLabel(wallet: WalletState["kind"]): string {
  switch (wallet) {
    case "no-wallet":
      return "A wallet is needed to buy";
    case "disconnected":
      return "Connect a wallet to buy";
    case "connecting":
      return "Waiting for your wallet";
    case "wrong-chain":
      return "Switch to Base to buy";
    case "balances-unreadable":
      return "We could not read your balances";
    case "checking":
      return "Checking what you hold";
    case "no-eth":
      return "ETH is needed for the network fee";
    case "no-usdc":
      return "Add USDC to buy";
    case "ready":
      // Unreachable: `tradeState` only returns `blocked` for a wallet that is not
      // ready. Present because the union has nine members and an inexhaustive switch
      // would return undefined into a button label.
      return "Buy";
  }
}

/**
 * The two-signatures explanation, and when it is on screen.
 *
 * BEFORE THE FIRST PROMPT, NEVER AFTER IT. Someone who has been told to be careful
 * about approvals reads a second wallet prompt as a scam, and the moment that prompt
 * appears is too late to explain why there are two. So this is rendered from
 * `needs-approval` — the state where we know an approval is coming — and stays up
 * through both of the approval states as the same sentence.
 *
 * The `ready` case is the other half of the same honesty: when the router can already
 * spend this much there is only one signature, and saying "two" there would be wrong.
 *
 * Null everywhere else. Once a purchase is in flight or finished, the count of
 * signatures is history.
 */
function signatureNote(state: TradeState | null, ngnIn: number | null): string | null {
  if (state === null) return null;

  const amount = ngnIn === null ? "this amount" : formatNGNAmount(ngnIn);

  switch (state.kind) {
    case "needs-approval":
      return (
        `This purchase takes two signatures. The first permits ${amount} of your ` +
        "USDC and no more — it is not an unlimited allowance. The second buys the " +
        "shares."
      );
    case "approving":
      return (
        `The first of the two: permission for ${amount}, and nothing beyond it. ` +
        "The second signature is the purchase itself."
      );
    case "approval-confirming":
      return "That was the first of two signatures. The purchase is the second.";
    case "ready":
      return (
        "One signature. Permission for this amount is already in place, so the only " +
        "thing left to sign is the purchase."
      );
    default:
      return null;
  }
}

/**
 * What just happened, in one sentence, for the states where something did.
 *
 * Null for every state whose whole story is already told by the button's label —
 * `checking-allowance`, `needs-approval`, `approving`, `building`, `signing` — because
 * a second region narrating the same step is noise in a live area a screen reader
 * reads out. Null for `blocked` too: `WalletConnect` states the wallet problem and
 * carries the action for it, and a second wording of it here would be a copy to keep
 * in step.
 *
 * EVERY ENDING SAYS WHAT LEFT THE WALLET AND WHAT DID NOT. That is the sentence people
 * actually need after a failure, and it is the one an app that only reports "something
 * went wrong" makes them guess at.
 */
function momentCopy(
  state: TradeState | null,
  fault: TradeFault | null,
  repriced: boolean,
): string | null {
  if (state === null) return null;

  switch (state.kind) {
    case "blocked":
    case "checking-allowance":
    case "needs-approval":
    case "approving":
    case "building":
    case "signing":
      return null;
    case "quote-expired":
      return "That price has run out. A new one is on its way.";
    case "approval-confirming":
      return "Base is recording your permission. This usually takes a few seconds.";
    case "ready":
      return repriced
        ? "The price moved while your purchase was being put together, so nothing was sent and the figures above are a fresh quote. Buy again if they still work for you."
        : null;
    case "confirming":
      return "Your purchase is on Base and usually settles within a few seconds.";
    case "confirmed":
      return "Bought. The shares are in your wallet.";
    case "reverted":
      return revertedCopy(state.step);
    case "rejected":
      return state.step === "approval"
        ? "You declined the permission in your wallet. Nothing was spent."
        : "You declined the purchase in your wallet. Nothing was spent.";
    case "failed":
      return fault === null ? lostCopy(state.step) : faultCopy(fault);
  }
}

/**
 * A transaction that was mined and failed.
 *
 * The user paid a network fee for nothing, so the copy says that outright and then says
 * what to do — the request's own point: the usual cause of a reverted swap is the price
 * moving past the floor named above, and the answer is a new price, not the same one
 * again. Guessing at a cause we cannot read from a receipt would be worse than useless,
 * so it is offered as the usual one rather than asserted.
 */
function revertedCopy(step: TradeStep): string {
  if (step === "approval") {
    return (
      "The permission reached Base and did not go through. Its network fee was " +
      "spent, and your USDC was not touched. Signing it again usually works."
    );
  }

  return (
    "Your purchase reached Base and did not go through. The network fee for it was " +
    "spent; nothing else left your wallet. The usual cause is the price moving past " +
    "the floor above while the transaction was in flight, so the answer is a new " +
    "price rather than the same one again."
  );
}

/**
 * A transaction we cannot account for.
 *
 * `txPhase` reports a receipt we could not fetch as `failed` rather than as a revert,
 * because we do not know what happened — it may well have settled. So the copy sends
 * the user to the explorer instead of telling them something we cannot see.
 */
function lostCopy(step: TradeStep): string {
  if (step === "approval") {
    return (
      "We lost track of the permission transaction. Check it on Basescan before " +
      "signing again — if it went through, you will not need to."
    );
  }

  return (
    "We lost track of your purchase, so we cannot say whether it settled. Check it " +
    "on Basescan before buying again."
  );
}

/**
 * A build that produced no transaction, said plainly.
 *
 * All three of these happen before a wallet opens, so all three can promise that
 * nothing was signed and nothing was spent — which is the first thing someone wants to
 * know when a purchase does not happen.
 *
 * `unsafe-build` is the only copy in the panel that does not offer another attempt,
 * because `action` offers no button for it. What it says instead is what we did: we
 * refused to sign a payload that disagreed with the router we pinned. That is a
 * success of the check, and the sentence is written so it does not read as our bug or
 * as their mistake.
 */
function faultCopy(fault: TradeFault): string {
  switch (fault.kind) {
    case "unsafe-build":
      return (
        "The purchase we were handed did not match the exchange Bourse is pinned to, " +
        "so we did not sign it. Nothing was spent. Reload this page before trying " +
        "again — we will not send a transaction we cannot verify."
      );
    case "no-route":
      return (
        "There is no route for this amount right now. Nothing was signed. A smaller " +
        "amount may still go through."
      );
    case "build-failed":
      return "We could not put the purchase together. Nothing was signed and nothing was spent.";
  }
}

/**
 * Which transaction the Basescan link points at, for the states that have one.
 *
 * Pending, confirmed and reverted all get a link, and the reason is in
 * `lib/rpc.ts`: the panel is telling someone what happened to their money, and a claim
 * about a transaction with no way to check it is a claim they have to take on our word.
 */
function txHash(
  state: TradeState | null,
  approvalHash: string | null,
  swapHash: string | null,
): string | null {
  if (state === null) return null;

  switch (state.kind) {
    case "approval-confirming":
      return approvalHash;
    case "confirming":
    case "confirmed":
      return swapHash;
    case "reverted":
    case "failed":
      return state.step === "approval" ? approvalHash : swapHash;
    default:
      // `rejected` included: a prompt someone declined never produced a hash, and a
      // build that failed before the wallet opened has no transaction to link to.
      return null;
  }
}

/** How the trade moment is coloured. `plain` is the default and the commonest. */
type MomentTone = "plain" | "notice" | "negative" | "positive";

/**
 * The colour on the trade moment, and it is never the only signal.
 *
 * Every state that gets a tone also gets a sentence from `momentCopy`, so the panel
 * reads the same in grayscale, at any contrast, and to a screen reader. That is the
 * rule the cost rows follow too — no tint on a spread or a network fee — and it is why
 * this function only ever adds emphasis to words that are already there.
 *
 * The mapping is the design system's own vocabulary. Emerald is reserved for action,
 * positive movement and ownership, and a settled purchase is all three. Red is strictly
 * semantic: a revert and a lost transaction both cost real money, so they get it, and
 * nothing else does. Amber is for market notices — a price that ran out, a price that
 * moved, no route at this size — none of which is a fault.
 *
 * `rejected` is deliberately plain. Declining a prompt is a decision someone made on
 * purpose, and colouring it red would read as an accusation for being careful.
 */
function momentTone(
  state: TradeState | null,
  fault: TradeFault | null,
  repriced: boolean,
): MomentTone {
  if (state === null) return "plain";

  switch (state.kind) {
    case "confirmed":
      return "positive";
    case "reverted":
      return "negative";
    case "failed":
      return fault?.kind === "no-route" ? "notice" : "negative";
    case "quote-expired":
      return "notice";
    case "ready":
      return repriced ? "notice" : "plain";
    default:
      return "plain";
  }
}
