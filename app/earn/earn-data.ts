import { unstable_cache } from "next/cache";

import { fetchEarnRates } from "@/lib/earn";

/**
 * The yields read, cached on its own key for 300 seconds.
 *
 * Five minutes, not thirty like prices: APRs move with volume and gauge
 * emissions rather than ticking every block, and the feed itself refreshes
 * far slower than that. Same arrangement as the markets caches otherwise —
 * `readAtMs` is produced inside the cached function so concurrent requests
 * share one upstream read, and a wobble resolves to a failure the page
 * renders rather than a throw.
 */
export const readCachedYields = unstable_cache(
  async () => fetchEarnRates(),
  ["earn-yields"],
  { revalidate: 300 },
);
