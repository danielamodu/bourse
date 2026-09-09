import { unstable_cache } from "next/cache";

import { readStockPrices } from "@/lib/read-prices";
import { probeTradeability } from "@/lib/tradeability";

/**
 * Shared server reads for the browsing pages (`/markets` and `/`).
 *
 * The feed read and the tradeability probe answer to different upstreams, so
 * they stay separate cache entries: a KyberSwap wobble must not throw away a
 * good feed read, and vice versa. Thirty seconds each, for the same reason —
 * concurrent page views share one round rather than each firing at endpoints
 * that rate-limit. Nothing here can throw: `probeTradeability` resolves every
 * branch to a verdict, so a bad round comes back as `unknown`.
 */
export const readCachedPrices = unstable_cache(
  async () => {
    const readAtMs = Date.now();
    return { prices: await readStockPrices(readAtMs), readAtMs };
  },
  ["markets-reference-prices"],
  { revalidate: 30 },
);

export const probeCachedTradeability = unstable_cache(
  async () => probeTradeability(),
  ["markets-tradeability-probe"],
  { revalidate: 30 },
);
