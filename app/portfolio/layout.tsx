import type { ReactNode } from "react";

import { Providers } from "../providers";

/** Wallet plumbing for the portfolio route, and only it. */
export default function PortfolioLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
