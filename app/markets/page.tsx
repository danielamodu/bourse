import { Suspense } from "react";

import { AppShell } from "@/components/AppShell";
import { STOCK_SYMBOLS } from "@/lib/tokens";

import { probeCachedTradeability, readCachedPrices } from "./markets-data";
import { MarketsGrid } from "./MarketsGrid";

/**
 * The market browser, on the ported markets visual.
 *
 * A server component: the 13 reference prices are read here, in one batched
 * `eth_call`, and tradeability is probed per token, so the page arrives with
 * its numbers already in the HTML and ships no wallet SDK. Browseable with no
 * wallet connected — nothing on this page reads an account and there is no
 * connect gate. Gating happens at the moment of action, in the trade flow.
 *
 * Rendered per request, not prerendered. Nothing here reads a header or a
 * cookie, so Next would otherwise treat the route as static and bake one feed
 * reading into the deployed HTML — every visitor would then see whatever NVDA
 * cost when the build ran. `revalidate` only narrows that window; it does not
 * close it, since the first request after a deploy still serves the build-time
 * page. A price this page presents in naira has to be read when someone asks
 * for it.
 *
 * The cost is one Multicall3 request per uncached page view, which is why the
 * read is batched and the endpoints rotate.
 */
export const dynamic = "force-dynamic";

export default function MarketsPage() {
  // walletAddress null: this page reads no account, so the shell links out
  // to connect rather than showing one.
  return (
    <AppShell walletAddress={null}>
      <div className="page-header">
        <div>
          <div className="eyebrow">MARKETS</div>
          <h1>Find your next hold.</h1>
          <p>Trade tokenized US stocks with a clear price in naira.</p>
        </div>
      </div>

      <Suspense fallback={<MarketsSkeleton />}>
        <Markets />
      </Suspense>
    </AppShell>
  );
}

async function Markets() {
  // Issued together: the feed read and the quote probe go to different
  // upstreams and neither needs the other's answer.
  const [{ prices, readAtMs }, reports] = await Promise.all([
    readCachedPrices(),
    probeCachedTradeability(),
  ]);

  return (
    <MarketsGrid prices={prices} reports={reports} readAtMs={readAtMs} />
  );
}

/** Placeholder cards, not a spinner: the grid does not jump when prices land. */
function MarketsSkeleton() {
  return (
    <div className="app-stock-grid" aria-busy="true">
      {STOCK_SYMBOLS.slice(0, 4).map((symbol) => (
        <div className="stock-card" key={symbol} aria-hidden="true">
          <div className="eyebrow">Loading markets…</div>
        </div>
      ))}
    </div>
  );
}
