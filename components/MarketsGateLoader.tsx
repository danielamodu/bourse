"use client";

import { default as nextDynamic } from "next/dynamic";

/**
 * The markets gate, split out of the server page.
 *
 * `next/dynamic` with `ssr: false` is only legal inside a Client Component,
 * so this tiny loader owns that call while `app/markets/page.tsx` stays a
 * server component. Everything the comment on `MarketsGate` promises —
 * lazy wallet SDK, bounce only settled visitors — holds through it.
 */
const MarketsGate = nextDynamic(
  () => import("./MarketsGate").then((module) => module.MarketsGate),
  { ssr: false },
);

export function MarketsGateLoader() {
  return <MarketsGate />;
}
