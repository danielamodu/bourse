"use client";

import { useEffect, useState } from "react";

import { rateSource } from "@/lib/rate-source";

/**
 * Live USD -> NGN rate.
 *
 * Once a rate has been seen it is never taken away: a failed poll keeps the
 * last known good value and flags `isStale` instead of returning null or 0, and
 * the last good value is persisted so a returning user sees a number on the
 * first paint rather than waiting on the network.
 */

export const NGN_RATE_POLL_MS = 60_000;

const STORAGE_KEY = "bourse.usd-ngn-rate.v1";

export type NGNRateState = {
  /** Null only before any rate has ever been seen — never null after that. */
  rate: number | null;
  /** True until the first poll settles; later polls do not flip it back. */
  loading: boolean;
  error: Error | null;
  /** When the returned rate was fetched, not when it was last read. */
  lastUpdated: number | null;
  /** The rate is readable but unconfirmed: a poll failed, or it came from storage. */
  isStale: boolean;
};

const INITIAL_STATE: NGNRateState = {
  rate: null,
  loading: true,
  error: null,
  lastUpdated: null,
  isStale: false,
};

export function useNGNRate(): NGNRateState {
  const [state, setState] = useState<NGNRateState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    // Read storage here rather than in a render-time initialiser so the server
    // and client agree on the first render.
    const cached = readCachedRate();
    if (cached) {
      setState((prev) =>
        prev.rate === null
          ? {
              rate: cached.rate,
              loading: true,
              error: null,
              lastUpdated: cached.fetchedAt,
              isStale: true,
            }
          : prev,
      );
    }

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { rate, fetchedAt } = await rateSource.getUsdToNgn();
        if (cancelled) return;
        writeCachedRate({ rate, fetchedAt });
        setState({
          rate,
          loading: false,
          error: null,
          lastUpdated: fetchedAt,
          isStale: false,
        });
      } catch (thrown) {
        if (cancelled) return;
        setState((prev) => ({
          rate: prev.rate,
          loading: false,
          error: thrown instanceof Error ? thrown : new Error(String(thrown)),
          lastUpdated: prev.lastUpdated,
          isStale: prev.rate !== null,
        }));
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), NGN_RATE_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return state;
}

type CachedRate = { rate: number; fetchedAt: number };

function readCachedRate(): CachedRate | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { rate, fetchedAt } = JSON.parse(raw) as Partial<CachedRate>;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      return null;
    }
    return {
      rate,
      fetchedAt:
        typeof fetchedAt === "number" && Number.isFinite(fetchedAt)
          ? fetchedAt
          : 0,
    };
  } catch {
    // Unavailable or corrupt storage is not worth surfacing.
    return null;
  }
}

function writeCachedRate(value: CachedRate): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the rate still works for this session.
  }
}
