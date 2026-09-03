import type { ReactNode } from "react";

import { Providers } from "../providers";

/**
 * The wallet stack, scoped to the trade route.
 *
 * It sits here rather than in the root layout so that `/markets` — a browsing
 * page with no account to read — ships none of it. wagmi, viem and the connector
 * barrel are a large download for someone on Nigerian mobile data, and this is
 * the first route that has any use for them.
 *
 * Rendering is still not gated on a connection. This mounts the plumbing; the
 * trade flow asks for a wallet at the moment of action.
 */
export default function TradeLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
