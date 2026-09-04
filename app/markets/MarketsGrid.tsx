"use client";

import { useMemo } from "react";

import { MarketCard } from "@/components/MarketCard";
import { useClock } from "@/hooks/useClock";
import { useNGNRate } from "@/hooks/useNGNRate";
import { cx } from "@/lib/cx";
import { NGN_PLACEHOLDER, formatNGN, formatUSD } from "@/lib/format";
import { withMarketPrice, withNgnRate, type StockPrice } from "@/lib/price";
import {
  STOCK_LIST,
  STOCK_SYMBOLS,
  type StockSymbol,
  type StockToken,
} from "@/lib/tokens";
import type { TradeabilityReports } from "@/lib/tradeability";

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
 * Group membership is derived and never authored: a token is in the first group
 * when a quote for it came back inside the price-impact budget, measured on the
 * server this render. There is no registry flag to read — the four that can be
 * bought today are decided by weekly Aerodrome gauge votes, so an authored list
 * would be wrong between them.
 */

type MarketsGridProps = {
  /** Reference prices read on the server, in USD. The naira join happens here. */
  prices: Record<StockSymbol, StockPrice>;
  /** What the aggregator said about each token, probed on the server. */
  reports: TradeabilityReports;
  /** The server clock when those prices were read. */
  readAtMs: number;
};

export function MarketsGrid({ prices, reports, readAtMs }: MarketsGridProps) {
  const { rate, isStale } = useNGNRate();
  const nowMs = useClock(readAtMs);

  const nothingLoaded = STOCK_SYMBOLS.every(
    (symbol) => prices[symbol].unusable !== null,
  );

  // One pass over the registry, split by verdict. Order inside each group stays
  // alphabetical because STOCK_LIST is.
  const { tradeable, rest } = useMemo(
    () => ({
      tradeable: STOCK_LIST.filter(
        (token) => reports[token.symbol].verdict === "tradeable",
      ),
      rest: STOCK_LIST.filter(
        (token) => reports[token.symbol].verdict !== "tradeable",
      ),
    }),
    [reports],
  );

  const card = (token: StockToken, index: number) => {
    const report = reports[token.symbol];

    return (
      <MarketCard
        key={token.symbol}
        token={token}
        price={withMarketPrice(
          withNgnRate(prices[token.symbol], rate),
          report.usdPerShare,
        )}
        tradeability={report.verdict}
        index={index}
        nowMs={nowMs}
      />
    );
  };

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
          Premium compares what a small order costs on Base right now against the
          Chainlink reference price. The reference publishes on US market hours;
          the tokens trade all week, so the two drift apart overnight.
        </p>
        <div className={styles.grid}>{tradeable.map(card)}</div>
        {tradeable.length === 0 ? (
          <p className={cx(styles.footnote, styles.notice)}>
            No token returned a usable quote just now, so there is nothing to buy
            on this page at the moment.
          </p>
        ) : null}
      </section>

      <section className={styles.group} aria-labelledby="group-listed">
        <h2 id="group-listed" className={styles.groupTitle}>
          Listed, not yet tradeable
        </h2>
        <p className={styles.groupNote}>
          These stocks are issued on Base but have no pool yet, so they cannot be
          bought here.
        </p>
        <div className={styles.grid}>{rest.map(card)}</div>
      </section>
    </>
  );
}
