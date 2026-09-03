"use client";

import { useEffect, useState } from "react";

/**
 * The clock that age captions are measured against.
 *
 * Ages have to keep up — a "29m old" caption that never moved would quietly turn
 * into a lie on a page left open, which is the one thing an age caption exists to
 * prevent. But `Date.now()` read during render differs between the server pass
 * and hydration, so it cannot be read there.
 *
 * Hence a seed. Pass a server timestamp (the moment the prices were read) and the
 * caption is in the server HTML and agrees with the first client render. Pass
 * nothing — for data that was fetched in the browser anyway, so no server
 * timestamp exists — and this returns null until mount, and the caller renders no
 * caption until there is an honest clock to render one from.
 */

const CLOCK_TICK_MS = 60_000;

export function useClock(initialMs: number | null = null): number | null {
  const [nowMs, setNowMs] = useState<number | null>(initialMs);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return nowMs;
}
