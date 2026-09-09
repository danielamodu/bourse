"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, ChevronRight, Sparkles } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { CompanyIcon } from "@/components/Brand";
import { NairaAmount } from "@/components/NairaAmount";
import { useStockPrices } from "@/hooks/useStockPrices";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useWallet } from "@/hooks/useWallet";
import { formatNGNAmount, formatShares } from "@/lib/format";
import { scaleBigInt } from "@/lib/price";
import {
  QUOTABLE_SYMBOLS,
  STOCK_TOKENS,
  TOKEN_DECIMALS,
  USDC_DECIMALS,
  type QuotableSymbol,
} from "@/lib/tokens";

/**
 * Holdings on the ported portfolio visual: quantities read off each token
 * contract, valued against the Chainlink reference and always labelled
 * approximate — the balance-to-price multiplier is unconfirmed until the
 * first funded buy, so no figure here is asserted as exact and no P&L is
 * derived at all. No charts: a big number carries the same information
 * without invented history.
 */
export default function PortfolioPage() {
  const wallet = useWallet({});
  const { balances, loading: balancesLoading, refetch } = useTokenBalances(
    wallet.address,
  );
  const { prices, ngnRate } = useStockPrices();
  const router = useRouter();
  const [graceExpired, setGraceExpired] = useState(false);

  // The dashboard is not public: a settled-disconnected visitor belongs on
  // sign-in. The grace period plus the settled-state check exist so a wallet
  // still silently reconnecting is never bounced mid-handshake — only
  // `disconnected` and `no-wallet` redirect, never `connecting` or
  // `checking`, however long they take.
  useEffect(() => {
    const timer = setTimeout(() => setGraceExpired(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  const gatedOut =
    graceExpired &&
    (wallet.state.kind === "disconnected" ||
      wallet.state.kind === "no-wallet");

  useEffect(() => {
    if (gatedOut) router.replace("/login");
  }, [gatedOut, router]);

  const holdings = QUOTABLE_SYMBOLS.map((symbol) => {
    const units = balances[symbol];
    const shares = units === null ? null : scaleBigInt(units, TOKEN_DECIMALS[symbol]);
    const ngnPerShare = prices[symbol].ngn;
    const value =
      shares === null || ngnPerShare === null ? null : shares * ngnPerShare;
    return { symbol, units, shares, value };
  }).filter(
    (holding): holding is typeof holding & { shares: number } =>
      holding.units !== null && holding.units > 0n && holding.shares !== null,
  );

  // Null when any holding cannot be valued: a total over a subset would
  // read as a whole. The label says approximate regardless.
  let total: number | null = holdings.length === 0 ? null : 0;
  for (const holding of holdings) {
    if (total === null || holding.value === null) {
      total = null;
      break;
    }
    total += holding.value;
  }

  const availableNgn =
    wallet.usdcUnits !== null && ngnRate !== null
      ? (Number(wallet.usdcUnits) / 10 ** USDC_DECIMALS) * ngnRate
      : null;

  const connected = wallet.address !== null;

  return (
    <AppShell walletAddress={wallet.address}>
      <div className="page-header">
        <div>
          <div className="eyebrow">PORTFOLIO / OVERVIEW</div>
          <h1>Your ownership, in view.</h1>
          <p>A calm view of what you hold and how it is moving.</p>
        </div>
        <button
          type="button"
          className="button button-dark button-small"
          onClick={() => refetch()}
        >
          Refresh <Sparkles size={15} />
        </button>
      </div>

      {!connected ? (
        <div className="empty-state" aria-busy={!gatedOut}>
          <h3>
            {gatedOut ? "Taking you to sign in" : "Checking your wallet"}
          </h3>
          <p>
            {gatedOut
              ? "Holdings live behind sign-in."
              : "This usually takes a few seconds."}
          </p>
        </div>
      ) : balancesLoading && holdings.length === 0 ? (
        <div className="empty-state">
          <h3>Reading your holdings</h3>
          <p>This usually takes a few seconds.</p>
        </div>
      ) : holdings.length === 0 ? (
        <div className="empty-state">
          <h3>No holdings yet</h3>
          <p>Buy your first shares to see them here.</p>
          <p style={{ marginTop: 18 }}>
            <Link href="/markets" className="button button-dark">
              Browse markets <ArrowRight size={15} />
            </Link>
          </p>
        </div>
      ) : (
        <>
          <section className="portfolio-overview">
            <div className="portfolio-value">
              <span>TOTAL APPROXIMATE VALUE</span>
              <strong>
                <NairaAmount value={formatNGNAmount(total)} rate={ngnRate}>
                  {formatNGNAmount(total)}
                </NairaAmount>
              </strong>
              <em>
                Approximate — valued at the reference price, which may be
                hours old
              </em>
            </div>
            <div className="portfolio-stat">
              <span>AVAILABLE</span>
              <strong>{formatNGNAmount(availableNgn)}</strong>
              <small>Ready to trade</small>
            </div>
            <div className="portfolio-stat">
              <span>HOLDINGS</span>
              <strong>{holdings.length}</strong>
              <small>
                Across {holdings.length} token{holdings.length === 1 ? "" : "s"}
              </small>
            </div>
          </section>

          <div className="section-heading compact">
            <div>
              <div className="eyebrow">YOUR HOLDINGS</div>
              <h2>Keep an eye on the long term.</h2>
            </div>
          </div>

          <div className="holdings-table">
            {holdings.map((holding) => (
              <HoldingRow
                key={holding.symbol}
                symbol={holding.symbol}
                shares={holding.shares}
                value={holding.value}
                rate={ngnRate}
              />
            ))}
          </div>
        </>
      )}
    </AppShell>
  );
}

function HoldingRow({
  symbol,
  shares,
  value,
  rate,
}: {
  symbol: QuotableSymbol;
  shares: number;
  value: number | null;
  rate: number | null;
}) {
  const token = STOCK_TOKENS[symbol];

  return (
    <div className="holding-row">
      <div className="holding-company">
        <CompanyIcon symbol={symbol} />
        <div>
          <strong>{token.name}</strong>
          <span>
            {token.tokenSymbol} · {formatShares(shares)} shares
          </span>
        </div>
      </div>
      <div className="holding-chart">
        <span>Approximate</span>
      </div>
      <div className="holding-value">
        <strong>
          <NairaAmount value={formatNGNAmount(value)} rate={rate}>
            {formatNGNAmount(value)}
          </NairaAmount>
        </strong>
        <span>at reference</span>
      </div>
      <Link href={`/trade/${symbol}`} aria-label={`Trade ${token.name}`}>
        <ChevronRight size={16} className="row-chevron" />
      </Link>
    </div>
  );
}
