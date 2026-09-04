"use client";

import type { UseQuoteResult } from "@/hooks/useQuote";
import { cx } from "@/lib/cx";
import {
  formatImpactBps,
  formatNGN,
  formatNGNAmount,
  formatPremiumBps,
  formatQuoteCountdown,
  formatShares,
  formatUSD,
} from "@/lib/format";
import type { StockToken } from "@/lib/tokens";

import styles from "./TradePanel.module.css";

/**
 * The highest-trust component in the app.
 *
 * Everything a person needs in order to judge a purchase is on screen at once and
 * none of it is collapsible: what they pay, what they receive, the rate, the
 * premium against the reference, the price impact, the estimated gas, and how
 * long the price is good for. Rows render with a placeholder when there is no
 * quote rather than disappearing, so the shape of the disclosure never changes
 * underneath someone.
 *
 * Purely presentational. Every judgement — whether an amount is quotable, whether
 * a quote has expired, what a naira figure converts to — was made in
 * `hooks/useQuote.ts` and `lib/quote-ngn.ts`.
 *
 * Read-only by construction: there is no confirm affordance here, because Phase 3
 * Part A quotes and does not sign. Nothing on this panel can move a token.
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
};

export function TradePanel({
  token,
  amount,
  onAmountChange,
  ngn,
  usdToNgnRate,
  quote,
  referenceAge,
}: TradePanelProps) {
  const { ngnQuote, status, secondsRemaining } = quote;
  const priced = ngnQuote !== null;

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
        <Row label="You pay" value={formatNGNAmount(ngn)} filled={ngn !== null} />

        <Row
          label="You receive (estimate)"
          value={`${formatShares(ngnQuote?.quote.shares ?? null)} ${token.tokenSymbol}`}
          filled={priced}
          caption="Estimated from the quoted route. The exact number is set when the trade goes through."
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

        <Row
          label="Price impact"
          value={formatImpactBps(ngnQuote?.quote.priceImpactBps ?? null)}
          filled={ngnQuote !== null && ngnQuote.quote.priceImpactBps !== null}
        />

        <Row
          label="Estimated gas"
          value={formatNGNAmount(ngnQuote?.gasNgn ?? null)}
          filled={ngnQuote !== null && ngnQuote.gasNgn !== null}
        />

        <Row
          label="Quote expires in"
          value={formatQuoteCountdown(secondsRemaining)}
          filled={priced && secondsRemaining !== null && secondsRemaining > 0}
        />
      </dl>

      <p
        id="trade-amount-status"
        className={cx(styles.status, noticeStatus(status) && styles.statusNotice)}
        aria-live="polite"
      >
        {statusCopy(quote)}
      </p>

      {status === "failed" ? (
        <button type="button" className={styles.retry} onClick={quote.refresh}>
          Try again
        </button>
      ) : null}

      <p className={styles.disclaimer}>
        This is a price check. Nothing is submitted, no wallet is connected, and
        every figure above is an estimate until a trade goes through.
      </p>
    </section>
  );
}

type RowProps = {
  label: string;
  value: string;
  /** False renders the value quietly — it is a placeholder, not a figure. */
  filled: boolean;
  caption?: string | undefined;
};

function Row({ label, value, filled, caption }: RowProps) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.valueCell}>
        <span className={cx(styles.value, !filled && styles.muted)}>
          {value}
        </span>
        {caption !== undefined && filled ? (
          <span className={styles.caption}>{caption}</span>
        ) : null}
      </dd>
    </div>
  );
}

/*
 * The premium is deliberately not coloured.
 *
 * Red is reserved for losses, failures and destructive actions, and paying a few
 * basis points above a reference that last published thirteen hours ago is none
 * of those. The sign in front of the figure already says which side of the
 * reference the market is on.
 */

/** Amber for the states worth reading, plain for the ordinary ones. */
function noticeStatus(status: UseQuoteResult["status"]): boolean {
  return (
    status === "failed" ||
    status === "no-liquidity" ||
    status === "too-small" ||
    status === "too-large" ||
    status === "unquotable"
  );
}

/**
 * One sentence per state.
 *
 * "We could not get a price" and "this cannot be bought at this size" are kept
 * apart deliberately: one is our failure and retryable, the other is a fact about
 * the market. Collapsing them would let a timeout tell someone a stock has no
 * market.
 */
function statusCopy({
  status,
  ngnQuote,
  minNgn,
  maxNgn,
}: UseQuoteResult): string {
  switch (status) {
    case "idle":
      return "Enter an amount to see a price.";
    case "unquotable":
      return "There is no published contract address for this token, so we cannot ask for a price.";
    case "too-small":
      return minNgn === null
        ? "That amount is too small to price."
        : `Enter at least ${formatNGNAmount(minNgn)} to get a price.`;
    case "too-large":
      return maxNgn === null
        ? "That amount is more than we can price at once."
        : `The most we can price at once is ${formatNGNAmount(maxNgn)}.`;
    case "loading":
      return ngnQuote === null ? "Getting a price…" : "Refreshing the price…";
    case "quote":
      return "This price holds for 30 seconds, then refreshes on its own.";
    case "no-liquidity":
      return "No route for this amount right now, so it cannot be bought at this size.";
    case "failed":
      return "We could not get a price just now.";
  }
}
