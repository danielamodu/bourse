import type { ReactNode } from "react";

import { Providers } from "../providers";

/** Wallet plumbing for the settings route, and only it. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
