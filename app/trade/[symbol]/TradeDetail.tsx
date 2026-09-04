"use client";

import Link from "next/link";
import { useState } from "react";

import { TradePanel } from "@/components/TradePanel";
import { WalletConnect } from "@/components/WalletConnect";
import { useClock } from "@/hooks/useClock";
import { useQuote } from "@/hooks/useQuote";
import { useStockPrices } from "@/hooks/useStockPrices";
import { cx } from "@/lib/cx";
import {
  formatFeedAge,
  formatNGNAmount,
  parseNgnAmount,
} from "@/lib/format";
import { STOCK_TOKENS, type StockSymbol } from "@/lib/tokens";

import styles from "./trade.module.css";

/**
 * One market, with a live quote.
 *
 * The reference price at the top and the quote in the panel are two different
 * numbers on purpose. The reference is Chainlink's, publishes on US market hours,
 * and is captioned with its own age. The quote is what a pool will actually
 * charge right now, and it is the one the premium is measured against.
 *
 * Read-only: this asks what a trade would cost. No approval, no signature, no
 * submission, and no wallet is required to see any of it.
 */

/**
 * The field starts at ₦50,000 — the reference ticket the impact budget was
 * calibrated for, and a realistic first order. A prefilled amount means the panel
 * arrives with real figures rather than a column of dashes.
 */
const DEFAULT_AMOUNT = "50,000";

export function TradeDetail({ symbol }: { symbol: StockSymbol }) {
  const token = STOCK_TOKENS[symbol];
  const { prices, ngnRate } = useStockPrices();
  const nowMs = useClock();

  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const ngn = parseNgnAmount(amount);

  const price = prices[symbol];
  const age = formatFeedAge(price.updatedAt, nowMs);

  const quote = useQuote({
    symbol,
    ngn,
    usdToNgnRate: ngnRate,
    referenceUsd: price.usd,
  });

  return (
    <main className={styles.page}>
      <Link href="/markets" className={styles.back}>
        Back to markets
      </Link>

      <p className={styles.eyebrow}>{token.tokenSymbol}</p>
      <h1 className={styles.name}>{token.name}</h1>

      <p className={cx(styles.price, price.ngn === null && styles.priceMissing)}>
        {formatNGNAmount(price.ngn)}
      </p>

      {/* The age is stated, never dramatised: the reference feed publishes 24/5
          and the token trades 24/7, so a reading hours old is the ordinary Lagos
          afternoon rather than a fault. */}
      {price.unusable !== null ? (
        <p className={styles.note}>
          No reference price for this token yet, so we cannot show what a share
          is worth.
        </p>
      ) : age !== null ? (
        <p className={cx(styles.note, price.stale && styles.notice)}>
          Reference price {age}. The token itself keeps trading.
        </p>
      ) : null}

      <TradePanel
        token={token}
        amount={amount}
        onAmountChange={setAmount}
        ngn={ngn}
        usdToNgnRate={ngnRate}
        quote={quote}
        referenceAge={age}
      />

      <WalletConnect />

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.label}>Token contract</dt>
          <dd className={cx(styles.value, token.address === null && styles.muted)}>
            {token.address ?? "Not published yet"}
          </dd>
        </div>

        {/* Read from the registry, not from a live call. The figure was read off each
            contract by `npm run verify:chain` and recorded with that provenance, so a
            second multicall on page load would add a round trip and — worse — a window
            where this row and the share count above it disagreed. Null where the token
            has no published address, because there was no contract to read it from. */}
        <div className={styles.fact}>
          <dt className={styles.label}>On-chain decimals</dt>
          <dd
            className={cx(styles.value, token.decimals === null && styles.muted)}
          >
            {token.decimals ?? "No contract to read yet"}
          </dd>
        </div>

        <div className={styles.fact}>
          <dt className={styles.label}>Reference feed</dt>
          <dd className={styles.value}>{token.feedAddress}</dd>
        </div>
      </dl>
    </main>
  );
}
