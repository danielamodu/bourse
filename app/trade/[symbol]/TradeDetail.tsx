"use client";

import Link from "next/link";

import { useClock } from "@/hooks/useClock";
import { useStockPrices } from "@/hooks/useStockPrices";
import { useTokenDecimals } from "@/hooks/useTokenDecimals";
import { cx } from "@/lib/cx";
import { formatFeedAge, formatNGNAmount } from "@/lib/format";
import { STOCK_TOKENS, type StockSymbol } from "@/lib/tokens";

import styles from "./trade.module.css";

/**
 * Phase 2 stub. Shows what we know about one market and nothing more — no
 * quote, no approval, no swap. The trade panel proper lands in Phase 3, and it
 * has to show payment, receipt, rate, price impact, gas and quote expiry
 * together, so half of it is worse than none of it.
 */
export function TradeDetail({ symbol }: { symbol: StockSymbol }) {
  const token = STOCK_TOKENS[symbol];
  const { prices } = useStockPrices();
  const { decimals } = useTokenDecimals();
  const nowMs = useClock();

  const price = prices[symbol];
  const tokenDecimals = decimals[symbol];
  const age = formatFeedAge(price.updatedAt, nowMs);

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

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.label}>Token contract</dt>
          <dd className={cx(styles.value, token.address === null && styles.muted)}>
            {token.address ?? "Not sourced yet"}
          </dd>
        </div>

        <div className={styles.fact}>
          <dt className={styles.label}>On-chain decimals</dt>
          <dd
            className={cx(
              styles.value,
              tokenDecimals === undefined && styles.muted,
            )}
          >
            {tokenDecimals ?? "Not read yet"}
          </dd>
        </div>

        <div className={styles.fact}>
          <dt className={styles.label}>Liquidity</dt>
          <dd className={cx(styles.value, !token.hasLiquidity && styles.muted)}>
            {token.hasLiquidity ? "Pool on Base" : "No pool on Base yet"}
          </dd>
        </div>
      </dl>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Buying arrives in Phase 3</h2>
        <p className={styles.panelBody}>
          When it does, this panel will show what you pay, what you receive, the
          conversion rate, price impact, estimated gas, and how long the quote
          lasts — all of it before you confirm anything.
        </p>
      </section>
    </main>
  );
}
