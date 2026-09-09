import { LandingContent } from "@/components/LandingContent";

import {
  probeCachedTradeability,
  readCachedPrices,
} from "./markets/markets-data";

/**
 * The landing page: editorial sections over live market numbers.
 *
 * A server component that reads the same cached reference prices and probe
 * as `/markets`, so the ticker, the preview cards and the trust terminal
 * arrive priced. No wallet stack ships here — connect actions link to
 * sign-in, and browsing comes before connecting.
 */
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const [{ prices, readAtMs }, reports] = await Promise.all([
    readCachedPrices(),
    probeCachedTradeability(),
  ]);

  return (
    <LandingContent prices={prices} reports={reports} readAtMs={readAtMs} />
  );
}
