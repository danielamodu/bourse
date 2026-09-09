import { Suspense } from "react";

import { AppShell } from "@/components/AppShell";
import { CompanyIcon } from "@/components/Brand";
import type { EarnPool } from "@/lib/earn";
import { QUOTABLE_SYMBOLS, STOCK_TOKENS } from "@/lib/tokens";

import { readCachedYields } from "./earn-data";

/**
 * Earn preview. Display-only: no deposit button, no approval, no wallet
 * transaction, nothing that touches the buy/approve/swap path — there is no
 * path from this page to a signature at all.
 *
 * A server component: one yields-feed read per uncached view, cached for
 * five minutes, with the read time printed beside the numbers. No wallet
 * SDK ships here; nothing on this page reads an account.
 *
 * Rendered per request, not prerendered, for the markets page's reason: a
 * baked-in APR would present a days-old variable figure as today's.
 */
export const dynamic = "force-dynamic";

/** The naira principal the per-pool example is worked at. An example, labelled. */
const EXAMPLE_PRINCIPAL_NGN = 100_000;

export default function EarnPage() {
  return (
    <AppShell walletAddress={null}>
      <div className="page-header">
        <div>
          <div className="eyebrow">EARN / PREVIEW</div>
          <h1>Put idle money to work.</h1>
          <p>Live yields on the pools behind your stocks. Display only for now.</p>
        </div>
      </div>

      <Suspense fallback={<PoolsSkeleton />}>
        <Pools />
      </Suspense>
    </AppShell>
  );
}

async function Pools() {
  const result = await readCachedYields();

  if (result.kind === "failed") {
    return (
      <div className="empty-state">
        <h3>Yields did not load</h3>
        <p>
          The yields feed did not answer just now ({result.detail}). Nothing
          here is estimated — try again in a moment.
        </p>
      </div>
    );
  }

  const { pools, lending, readAtMs } = result.snapshot;
  const readAt = formatUtc(readAtMs);

  const ordered = QUOTABLE_SYMBOLS.map((symbol) =>
    pools.find((pool) => pool.symbol === symbol),
  ).filter((pool): pool is EarnPool => pool !== undefined);

  return (
    <>
      <div className="info-note">
        <strong>Preview — deposits coming soon.</strong> You can&apos;t deposit
        yet. These figures are live reads, not an offer.
      </div>

      <p className="chart-updated" style={{ margin: "25px 0" }}>
        <i /> APRs via DefiLlama, computed from Aerodrome pools · read {readAt}
      </p>

      {ordered.map((pool) => (
        <PoolCard key={pool.symbol} pool={pool} />
      ))}

      {lending === null ? null : (
        <section aria-label="USDC lending" style={{ marginTop: 48 }}>
          <div className="eyebrow">USDC LENDING</div>
          <div className="portfolio-overview" style={{ marginTop: 18 }}>
            <div className="portfolio-value">
              <span>{lending.venue} SUPPLY APY</span>
              <strong>{formatPct(lending.apy)}</strong>
              <em>For USDC sitting still, no pool position.</em>
            </div>
            <div className="portfolio-stat">
              <span>TVL</span>
              <strong>{formatUsd(lending.tvlUsd)}</strong>
              <small>Lent out</small>
            </div>
            <div className="portfolio-stat">
              <span>EXAMPLE</span>
              <strong>{examplePerYear(lending.apy)}</strong>
              <small>Per year, at today&apos;s rate</small>
            </div>
          </div>
        </section>
      )}

      <div className="info-note" style={{ marginTop: 48 }}>
        <strong>Variable, never guaranteed.</strong> These APRs move with
        trading volume and AERO emissions, and can fall as fast as they rose.
        Providing liquidity also carries impermanent loss: when the two token
        prices move apart, the position can end up worth less than simply
        holding both. A high APR is never a promise.
      </div>
    </>
  );
}

function PoolCard({ pool }: { pool: EarnPool }) {
  const token = STOCK_TOKENS[pool.symbol];

  // The emissions leg is labelled as what it is — a variable bonus that
  // decays — and never folded into the naira illustration below.
  const split =
    pool.apyBase === null && pool.apyReward === null
      ? "Fee/emissions split unavailable"
      : pool.apyBase === null
        ? `Variable AERO bonus ${pool.apyReward?.toFixed(2)}% (decays) · fee split unavailable`
        : pool.apyReward === null
          ? `${pool.apyBase.toFixed(2)}% trading fees · emissions split unavailable`
          : `${pool.apyBase.toFixed(2)}% trading fees + ${pool.apyReward.toFixed(2)}% variable AERO bonus (decays)`;

  return (
    <section aria-label={`${token.name} pool`} style={{ marginTop: 48 }}>
      <div className="holding-company">
        <CompanyIcon symbol={pool.symbol} />
        <div>
          <strong>
            USDC / {token.tokenSymbol}
          </strong>
          <span>Aerodrome LP</span>
        </div>
      </div>
      <div className="portfolio-overview" style={{ marginTop: 18 }}>
        <div className="portfolio-value">
          <span>CURRENT APR</span>
          <strong>{formatPct(pool.apy)}</strong>
          <em>{split}</em>
        </div>
        <div className="portfolio-stat">
          <span>TVL</span>
          <strong>{formatUsd(pool.tvlUsd)}</strong>
          <small>In the pool</small>
        </div>
        {/* The naira illustration prices the fee leg only. Projecting the
            emissions-inflated total would read as a payout promise — on a
            5000% pool that is ₦100k turning into millions — so where the fee
            split is unavailable there is no illustration at all. */}
        {pool.apyBase === null ? null : (
          <div className="portfolio-stat">
            <span>EXAMPLE</span>
            <strong>{examplePerYear(pool.apyBase)}</strong>
            <small>
              At today&apos;s fee rate, before impermanent loss — not a
              projection
            </small>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * `~₦Y/yr on ₦100,000`: a worked example off the fee leg only, labelled as a
 * today-snapshot. It must never read as "you will earn this."
 */
function examplePerYear(feeApy: number): string {
  const perYear = (EXAMPLE_PRINCIPAL_NGN * feeApy) / 100;
  return `~₦${Math.round(perYear).toLocaleString("en-US")}/yr on ₦${EXAMPLE_PRINCIPAL_NGN.toLocaleString("en-US")}`;
}

function formatPct(apy: number): string {
  return `${apy.toFixed(2)}%`;
}

function formatUsd(tvlUsd: number): string {
  return `$${tvlUsd.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  })}`;
}

/** `2026-09-09 14:32 UTC` — deterministic, no server-locale surprises. */
function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function PoolsSkeleton() {
  return (
    <div className="portfolio-overview" aria-busy="true">
      <div className="portfolio-value">
        <span>READING YIELDS…</span>
      </div>
    </div>
  );
}
