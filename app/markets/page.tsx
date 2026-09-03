import { Suspense } from "react";

import { MarketCardSkeleton } from "@/components/MarketCard";
import { readStockPrices } from "@/lib/read-prices";
import { STOCK_SYMBOLS } from "@/lib/tokens";

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
 */
async function Markets() {
  const readAtMs = Date.now();
  const prices = await readStockPrices(readAtMs);

  return <MarketsGrid prices={prices} readAtMs={readAtMs} />;
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
