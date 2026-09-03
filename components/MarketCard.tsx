import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { cx } from "@/lib/cx";
import {
  formatFeedAge,
  formatNGNAmount,
  formatPremiumBps,
} from "@/lib/format";
import type { FeedUnusableReason, StockPrice } from "@/lib/price";
import type { StockToken } from "@/lib/tokens";

import styles from "./MarketCard.module.css";

type MarketCardProps = {
  token: StockToken;
  price: StockPrice;
  /** Position in the grid, for the staggered entrance. */
  index: number;
  /** Clock the reference age is measured against. Null before it is known. */
  nowMs: number | null;
};

/**
 * One market.
 *
 * Two treatments, and which one a token gets is derived from `hasLiquidity`
 * rather than passed in — a card cannot be told to show a buy affordance for a
 * token nothing will quote.
 *
 * Tradeable: the full card, and the whole card is the link.
 * Listed only: reference price and its age, quieter, and no buy affordance at
 * all. Not a disabled button — that invites a click and then explains nothing.
 * The reason those tokens cannot be bought is stated once above the group.
 *
 * Presentational throughout: every judgement about whether a price is usable or
 * current was already made in lib/price.
 */
export function MarketCard({ token, price, index, nowMs }: MarketCardProps) {
  const stagger = { "--stagger": index } as CSSProperties;
  const age = formatFeedAge(price.updatedAt, nowMs);

  const heading = (
    <>
      <div className={styles.head}>
        <h3 className={styles.name}>{token.name}</h3>
        <span className={styles.ticker}>{token.tokenSymbol}</span>
      </div>

      <p className={cx(styles.price, price.ngn === null && styles.priceMissing)}>
        {formatNGNAmount(price.ngn)}
      </p>
    </>
  );

  /*
   * Age is stated factually and never as an alarm: these feeds stop publishing
   * while US markets are shut, so for a Lagos afternoon a reading hours old is
   * the ordinary condition. `price.stale` is the one case worth a notice colour —
   * lib/price sets it past the point where "markets are shut" stops explaining
   * the gap and a feed problem starts.
   */
  const reference =
    price.unusable !== null ? (
      <p className={styles.note}>{unusableCopy(price.unusable)}</p>
    ) : age !== null ? (
      <p className={cx(styles.note, price.stale && styles.notice)}>
        Reference price {age}.
      </p>
    ) : null;

  if (!token.hasLiquidity) {
    return (
      <article className={cx(styles.card, styles.quiet)} style={stagger}>
        {heading}
        {reference}
      </article>
    );
  }

  return (
    <Link
      href={`/trade/${token.symbol}`}
      className={cx(styles.card, styles.link)}
      style={stagger}
    >
      {heading}

      <div className={styles.rows}>
        <div className={styles.row}>
          <span className={styles.label}>Premium vs reference</span>
          <span className={cx(styles.value, premiumTone(price.premiumBps))}>
            {formatPremiumBps(price.premiumBps)}
          </span>
        </div>
      </div>

      {reference}

      <span className={styles.action}>Buy shares</span>
    </Link>
  );
}

/** Placeholder cards. Skeletons, not spinners — the layout does not jump. */
export function MarketCardSkeleton({ index }: { index: number }) {
  const stagger = { "--stagger": index } as CSSProperties;

  return (
    <article className={styles.card} style={stagger} aria-hidden="true">
      <div className={cx(styles.skeletonLine, styles.skeletonName)} />
      <div className={cx(styles.skeletonLine, styles.skeletonPrice)} />
      <div className={cx(styles.skeletonLine, styles.skeletonRow)} />
    </article>
  );
}

function premiumTone(bps: number | null): string | undefined {
  if (bps === null || bps === 0) return styles.muted;
  return bps > 0 ? styles.positive : styles.negative;
}

function unusableCopy(reason: FeedUnusableReason): ReactNode {
  switch (reason) {
    case "no-feed":
      return "No price feed connected for this token yet.";
    case "not-read":
      return "Price did not load. It will retry shortly.";
    case "non-positive-answer":
      return "The reference feed has no usable price right now.";
    case "bad-decimals":
      return "The reference feed returned a price we cannot read.";
  }
}
