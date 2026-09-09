"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { formatFeedAge, formatNGNAmount, formatPremiumBps } from "@/lib/format";
import type { StockPrice } from "@/lib/price";
import type { StockToken } from "@/lib/tokens";
import type { Tradeability } from "@/lib/tradeability";

import { CompanyIcon } from "./Brand";
import { NairaAmount } from "./NairaAmount";

/**
 * One market card, in the ported `stock-card` visual.
 *
 * Tradeable: the whole card links to the trade screen and carries a quick-buy
 * affordance. Everything else: reference price and its age, quieter, with no
 * buy affordance at all — not a disabled button, which invites a click and
 * then explains nothing. Which treatment a token gets follows the
 * tradeability verdict, which is a quote that came back inside the impact
 * budget rather than a flag anybody wrote down.
 *
 * No sparkline and no 24h change: there is no price-history source, and the
 * card will not invent one. The bottom row states the reference age instead.
 * The star is local UI state only — it remembers nothing beyond the render.
 */
export function StockCard({
  token,
  price,
  tradeability,
  rate,
  index,
  nowMs,
  saved,
  onToggleSaved,
}: {
  token: StockToken;
  price: StockPrice;
  tradeability: Tradeability;
  /** USD to NGN for the hover conversion. Null renders no tooltip. */
  rate: number | null;
  /** Position in the grid, for the staggered entrance. */
  index: number;
  /** Clock the reference age is measured against. Null before it is known. */
  nowMs: number | null;
  saved: boolean;
  onToggleSaved: () => void;
}) {
  const age = formatFeedAge(price.updatedAt, nowMs);

  const body = (
    <>
      <div className="stock-card-top">
        <CompanyIcon symbol={token.symbol} />
        <button
          type="button"
          className={`save-button ${saved ? "saved" : ""}`}
          aria-label={saved ? `Remove ${token.symbol} from watchlist` : `Save ${token.symbol} to watchlist`}
          aria-pressed={saved}
          onClick={(event) => {
            event.preventDefault();
            onToggleSaved();
          }}
        >
          {saved ? "★" : "☆"}
        </button>
      </div>

      <div className="stock-name">
        <strong>{token.name}</strong>
        <span>{token.tokenSymbol}</span>
      </div>

      <div className="stock-price">
        <strong>
          <NairaAmount value={formatNGNAmount(price.ngn)} rate={rate}>
            {formatNGNAmount(price.ngn)}
          </NairaAmount>
        </strong>
        {tradeability === "tradeable" ? (
          <div className={premiumTone(price.premiumBps)}>
            {formatPremiumBps(price.premiumBps)} <span>vs reference</span>
          </div>
        ) : null}
      </div>

      <div className="stock-card-bottom">
        <span>
          {price.unusable !== null
            ? "Reference unavailable"
            : age === null
              ? "Reference price"
              : `Reference ${age}`}
        </span>
        {tradeability === "tradeable" ? (
          <span className="quick-buy">
            Quick buy <ArrowUpRight size={14} />
          </span>
        ) : null}
      </div>

      {tradeability === "unknown" ? (
        <div className="stock-card-bottom">
          <span>We could not get a price for this one just now.</span>
        </div>
      ) : null}
    </>
  );

  if (tradeability !== "tradeable") {
    return (
      <div className="stock-card" style={{ animationDelay: `${index * 60}ms` }}>
        {body}
      </div>
    );
  }

  return (
    <Link
      href={`/trade/${token.symbol}`}
      className="stock-card"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {body}
    </Link>
  );
}

function premiumTone(bps: number | null): string {
  if (bps === null || bps === 0) return "";
  return bps > 0 ? "positive" : "negative";
}
