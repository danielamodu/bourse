import { NextResponse } from "next/server";

import type { NgnRatePayload } from "@/lib/rate-source";

/**
 * USD -> NGN rate proxy.
 *
 * The browser never talks to the upstream provider: it polls this route, so the
 * provider stays server-side and swappable (a future onramp quote will need a
 * key that must not ship to the client).
 */

const UPSTREAM_URL = "https://open.er-api.com/v6/latest/USD";
const SOURCE_ID = "open.er-api.com";
const REVALIDATE_SECONDS = 600;

/**
 * The handler runs per request; the `revalidate` on the fetch below is what
 * bounds upstream calls to one per 10 minutes. Per-fetch cache options take
 * precedence over the segment default, so these two are not in conflict —
 * without `force-dynamic` a failed or build-time response could get frozen
 * into the full route cache.
 */
export const dynamic = "force-dynamic";

type UpstreamPayload = {
  result?: string;
  rates?: Record<string, unknown>;
};

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET() {
  try {
    // `next.revalidate` is typed locally so this compiles before Next has
    // generated next-env.d.ts, which is where that augmentation lives.
    const init: RequestInit & { next?: { revalidate?: number } } = {
      headers: { accept: "application/json" },
      next: { revalidate: REVALIDATE_SECONDS },
    };

    const upstream = await fetch(UPSTREAM_URL, init);

    if (!upstream.ok) {
      return failed(`upstream responded with ${upstream.status}`);
    }

    const body = (await upstream.json()) as UpstreamPayload;

    if (typeof body.result === "string" && body.result !== "success") {
      return failed(`upstream reported result="${body.result}"`);
    }

    const rate = Number(body.rates?.NGN);

    if (!Number.isFinite(rate) || rate <= 0) {
      return failed(
        `upstream returned an unusable NGN rate: ${String(body.rates?.NGN)}`,
      );
    }

    const payload: NgnRatePayload = {
      rate,
      fetchedAt: Date.now(),
      source: SOURCE_ID,
    };

    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (cause) {
    return failed("upstream request threw", cause);
  }
}

function failed(reason: string, cause?: unknown) {
  console.error(`[ngn-rate] ${reason}`, cause ?? "");
  return NextResponse.json(
    { error: "USD/NGN rate is unavailable" },
    { status: 502, headers: NO_STORE },
  );
}
