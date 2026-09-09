import type { ReactNode } from "react";

import { Providers } from "../providers";

/** Wallet plumbing for the sign-in screens, and only them. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
