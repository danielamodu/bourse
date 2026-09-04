import { unstable_cache } from "next/cache";
import { Suspense } from "react";

import { MarketCardSkeleton } from "@/components/MarketCard";
import { readStockPrices } from "@/lib/read-prices";
import { STOCK_SYMBOLS } from "@/lib/tokens";
import { probeTradeability } from "@/lib/tradeability";

import { MarketsGrid } from "./MarketsGrid";
import styles from "./markets.module.css";

/**
 * The market browser.
 *
 * A server component: the 13 reference prices are read here, in one batched
 * `eth_call`, so the page arrives with its numbers already in the HTML and ships
 * no wallet SDK. Browseable with no wallet connected — nothing on this page reads
 * an account and there is no connect gate. Gating happens at the moment of
 * action, in the trade flow.
 *
 * Rendered per request, not prerendered. Nothing here reads a header or a cookie,
 * so Next would otherwise treat the route as static and bake one feed reading
 * into the deployed HTML — every visitor would then see whatever NVDA cost when
 * the build ran. `revalidate` only narrows that window; it does not close it,
 * since the first request after a deploy still serves the build-time page. A
 * price this page presents in naira has to be read when someone asks for it.
 *
 * The cost is one Multicall3 request per uncached page view, which is why the
 * read is batched and the endpoints rotate.
 */
export const dynamic = "force-dynamic";

export default function MarketsPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Buy US stocks with naira</h1>
        <p className={styles.lede}>
          Coinbase tokenized US stocks on Base, priced in naira. Look around
          first — you only connect a wallet when you buy.
        </p>
      </header>

      <Suspense fallback={<MarketsSkeleton />}>
        <Markets />
      </Suspense>
    </main>
  );
}

/**
 * The feed read, split out so the header streams ahead of it. Base's public RPCs
 * are not always quick, and a header plus skeletons beats a blank page for
 * someone on mobile data.
 *
 * Cached for 30 seconds in the data cache, which is a different cache from the
 * one `force-dynamic` turns off: the route still renders per request, but
 * concurrent requests share one Multicall3 read instead of each firing their own
 * at an endpoint that rate-limits after about a dozen calls. Thirty seconds is
 * nothing measured against feeds that were 29 minutes to 15 hours old when last
 * checked.
 *
 * `readAtMs` is produced inside the cached function, not passed into it — as an
 * argument it would land in the cache key and nothing would ever hit. It comes
 * back with the prices so it describes when *they* were read, which is what the
 * age caption needs. Per-token age stays correct either way, since it derives
 * from each feed's own `updatedAt` rather than from this timestamp.
 */
const readCachedPrices = unstable_cache(
  async () => {
    const readAtMs = Date.now();
    return { prices: await readStockPrices(readAtMs), readAtMs };
  },
  ["markets-reference-prices"],
  { revalidate: 30 },
);

/**
 * The tradeability probe, cached on its own key.
 *
 * Four quote requests to KyberSwap, one per published token. Cached for the same
 * 30 seconds and for the same reason as the price read: concurrent page views
 * should share one round of probing rather than each firing four requests at an
 * aggregator that has no obligation to serve us.
 *
 * A separate cache entry from the prices because the two answer to different
 * upstreams — a KyberSwap wobble should not throw away a good feed read, and vice
 * versa. Nothing here can throw: `probeTradeability` resolves every branch to a
 * verdict, so a bad round comes back as `unknown` and the grid says so.
 */
const probeCachedTradeability = unstable_cache(
  async () => probeTradeability(),
  ["markets-tradeability-probe"],
  { revalidate: 30 },
);

async function Markets() {
  // Issued together: the feed read and the quote probe go to different upstreams
  // and neither needs the other's answer.
  const [{ prices, readAtMs }, reports] = await Promise.all([
    readCachedPrices(),
    probeCachedTradeability(),
  ]);

  return (
    <MarketsGrid prices={prices} reports={reports} readAtMs={readAtMs} />
  );
}

/** Skeleton cards, not a spinner: the grid does not jump when prices land. */
function MarketsSkeleton() {
  return (
    <div className={styles.group} aria-busy="true">
      <div className={styles.grid}>
        {STOCK_SYMBOLS.map((symbol, index) => (
          <MarketCardSkeleton key={symbol} index={index} />
        ))}
      </div>
    </div>
  );
}
