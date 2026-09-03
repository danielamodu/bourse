"use client";

import { MarketCard } from "@/components/MarketCard";
import { useClock } from "@/hooks/useClock";
import { useNGNRate } from "@/hooks/useNGNRate";
import { cx } from "@/lib/cx";
import { NGN_PLACEHOLDER, formatNGN, formatUSD } from "@/lib/format";
import { withNgnRate, type StockPrice } from "@/lib/price";
import {
  LISTED_ONLY_LIST,
  STOCK_SYMBOLS,
  TRADEABLE_LIST,
  type StockSymbol,
  type StockToken,
} from "@/lib/tokens";

import styles from "./markets.module.css";

/**
 * The two market groups, plus the naira rate they are priced at.
 *
 * A client component with no wallet stack in it. The reference prices arrive
 * already read on the server, so `/markets` ships no wagmi — a browsing page has
 * no business sending a wallet SDK to someone on Nigerian mobile data. What has
 * to run in the browser is the naira rate, which polls so it stays live and
 * survives a failed fetch, and the clock the reference ages are measured against.
 *
 * Group membership is derived, not authored here: `TRADEABLE_LIST` and
 * `LISTED_ONLY_LIST` are both filters over the same registry.
 */

type MarketsGridProps = {
  /** Reference prices read on the server, in USD. The naira join happens here. */
  prices: Record<StockSymbol, StockPrice>;
  /** The server clock when those prices were read. */
  readAtMs: number;
};

export function MarketsGrid({ prices, readAtMs }: MarketsGridProps) {
  const { rate, isStale } = useNGNRate();
  const nowMs = useClock(readAtMs);

  const nothingLoaded = STOCK_SYMBOLS.every(
    (symbol) => prices[symbol].unusable !== null,
  );

  const card = (token: StockToken, index: number) => (
    <MarketCard
      key={token.symbol}
      token={token}
      price={withNgnRate(prices[token.symbol], rate)}
      index={index}
      nowMs={nowMs}
    />
  );

  return (
    <>
      <div className={styles.rate}>
        <span className={styles.rateLabel}>Rate used</span>
        <span className={styles.rateValue}>
          {rate === null
            ? NGN_PLACEHOLDER
            : `${formatNGN(1, rate)} per ${formatUSD(1)}`}
        </span>
        {isStale ? (
          <span className={styles.rateNotice}>
            Unconfirmed — this is the last rate we were able to fetch.
          </span>
        ) : null}
      </div>

      {nothingLoaded ? (
        <p className={cx(styles.footnote, styles.notice)}>
          The reference feeds did not respond, so no prices are showing right
          now.
        </p>
      ) : null}

      <section className={styles.group} aria-labelledby="group-tradeable">
        <h2 id="group-tradeable" className={styles.groupTitle}>
          Tradeable
        </h2>
        <p className={styles.groupNote}>
          Premium compares a live market quote against the Chainlink reference
          price. Quoting arrives with buying, so there is nothing to compare yet.
        </p>
        <div className={styles.grid}>{TRADEABLE_LIST.map(card)}</div>
      </section>

      <section className={styles.group} aria-labelledby="group-listed">
        <h2 id="group-listed" className={styles.groupTitle}>
          Listed, not yet tradeable
        </h2>
        <p className={styles.groupNote}>
          These stocks are issued on Base but have no pool yet, so they cannot be
          bought here.
        </p>
        <div className={styles.grid}>{LISTED_ONLY_LIST.map(card)}</div>
      </section>
    </>
  );
}
