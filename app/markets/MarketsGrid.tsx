"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { StockCard } from "@/components/StockCard";
import { useClock } from "@/hooks/useClock";
import { useNGNRate } from "@/hooks/useNGNRate";
import { formatNGN, formatUSD, NGN_PLACEHOLDER } from "@/lib/format";
import { withMarketPrice, withNgnRate, type StockPrice } from "@/lib/price";
import {
  STOCK_LIST,
  STOCK_SYMBOLS,
  type StockSymbol,
  type StockToken,
} from "@/lib/tokens";
import type { TradeabilityReports } from "@/lib/tradeability";

/**
 * Search, filters and the two market groups, on the ported markets visual.
 *
 * A client component with no wallet stack in it. The reference prices arrive
 * already read on the server, so `/markets` ships no wagmi. What runs in the
 * browser is the naira rate, which polls so it stays live and survives a
 * failed fetch, the clock the reference ages are measured against, and local
 * UI state for search, tabs and the watchlist.
 *
 * The tabs name what they filter: tradeable and reference are the two honest
 * groups, and the watchlist is the saved set. Gainers and losers would need
 * price-movement data nobody holds, so they are not offered rather than
 * computed from a number that is not a movement.
 *
 * Group membership is derived and never authored: a token is in the first
 * group when a quote for it came back inside the price-impact budget,
 * measured on the server this render.
 */

type MarketsGridProps = {
  /** Reference prices read on the server, in USD. The naira join happens here. */
  prices: Record<StockSymbol, StockPrice>;
  /** What the aggregator said about each token, probed on the server. */
  reports: TradeabilityReports;
  /** The server clock when those prices were read. */
  readAtMs: number;
};

type Tab = "All" | "Tradeable" | "Reference" | "Watchlist";

const TABS: Tab[] = ["All", "Tradeable", "Reference", "Watchlist"];

export function MarketsGrid({ prices, reports, readAtMs }: MarketsGridProps) {
  const { rate, isStale } = useNGNRate();
  const nowMs = useClock(readAtMs);
  const [tab, setTab] = useState<Tab>("All");
  const [search, setSearch] = useState("");
  const [saved, setSaved] = useState<ReadonlySet<StockSymbol>>(new Set());

  const toggleSaved = (symbol: StockSymbol) => {
    setSaved((previous) => {
      const next = new Set(previous);
      if (next.has(symbol)) {
        next.delete(symbol);
      } else {
        next.add(symbol);
      }
      return next;
    });
  };

  const nothingLoaded = STOCK_SYMBOLS.every(
    (symbol) => prices[symbol].unusable !== null,
  );

  const matchesSearch = (token: StockToken) =>
    `${token.name} ${token.symbol} ${token.tokenSymbol}`
      .toLowerCase()
      .includes(search.toLowerCase());

  // One pass over the registry, split by verdict. Order inside each group
  // stays alphabetical because STOCK_LIST is.
  const { tradeable, rest } = useMemo(() => {
    const inTab = (token: StockToken) => {
      if (!matchesSearch(token)) return false;
      switch (tab) {
        case "All":
          return true;
        case "Tradeable":
          return reports[token.symbol].verdict === "tradeable";
        case "Reference":
          return reports[token.symbol].verdict !== "tradeable";
        case "Watchlist":
          return saved.has(token.symbol);
      }
    };
    return {
      tradeable: STOCK_LIST.filter(
        (token) => reports[token.symbol].verdict === "tradeable" && inTab(token),
      ),
      rest: STOCK_LIST.filter(
        (token) => reports[token.symbol].verdict !== "tradeable" && inTab(token),
      ),
    };
    // matchesSearch closes over `search`; naming it reads better split out,
    // so it is listed rather than inlined.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports, tab, search, saved]);

  const card = (token: StockToken, index: number) => {
    const report = reports[token.symbol];
    return (
      <StockCard
        key={token.symbol}
        token={token}
        price={withMarketPrice(
          withNgnRate(prices[token.symbol], rate),
          report.usdPerShare,
        )}
        tradeability={report.verdict}
        rate={rate}
        index={index}
        nowMs={nowMs}
        saved={saved.has(token.symbol)}
        onToggleSaved={() => toggleSaved(token.symbol)}
      />
    );
  };

  const empty =
    tradeable.length === 0 && rest.length === 0 ? (
      <div className="empty-state">
        <Search size={26} />
        <h3>No stocks match</h3>
        <p>Try a different company name or symbol.</p>
      </div>
    ) : null;

  const showTradeable =
    tab === "All" ||
    tab === "Tradeable" ||
    (tab === "Watchlist" && tradeable.length > 0);
  const showRest = tab !== "Tradeable" && rest.length > 0;

  return (
    <>
      <div className="market-controls">
        <div className="search-field">
          <Search size={17} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search companies or symbols"
            aria-label="Search companies or symbols"
          />
        </div>
        <div className="filter-tabs" role="tablist" aria-label="Market filters">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={tab === item ? "active" : ""}
              onClick={() => setTab(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <p className="chart-updated" style={{ marginBottom: 25 }}>
        <i />{" "}
        {rate === null ? (
          NGN_PLACEHOLDER
        ) : (
          <>
            Rate {formatNGN(1, rate)} per {formatUSD(1)}
            {isStale ? " · unconfirmed — last rate we could fetch" : ""}
          </>
        )}
      </p>

      {nothingLoaded ? (
        <div className="empty-state">
          <h3>Prices did not load</h3>
          <p>The reference feeds did not respond just now.</p>
        </div>
      ) : null}

      {showTradeable ? (
        <section aria-label="Tradeable">
          <div className="eyebrow">TRADEABLE</div>
          <div className="app-stock-grid" style={{ marginTop: 18 }}>
            {tradeable.map(card)}
          </div>
          {tradeable.length === 0 ? (
            <div className="empty-state">
              <h3>Nothing to buy at the moment</h3>
              <p>No token returned a usable quote just now.</p>
            </div>
          ) : null}
        </section>
      ) : null}

      {showRest ? (
        <section aria-label="Listed, not yet tradeable" style={{ marginTop: 48 }}>
          <div className="eyebrow">LISTED, NOT YET TRADEABLE</div>
          <p style={{ marginTop: 12 }}>
            These stocks are issued on Base but have no pool yet, so they
            cannot be bought here.
          </p>
          <div className="app-stock-grid" style={{ marginTop: 18 }}>
            {rest.map(card)}
          </div>
        </section>
      ) : null}

      {empty}
    </>
  );
}
