import {
  TOKEN_ADDRESSES,
  USDC_ADDRESS,
  type QuotableSymbol,
} from "@/lib/tokens";

/**
 * Aerodrome yield preview. Reads only, no wallet, no signature.
 *
 * The venue's own frontend has no keyless API for this, and deriving an APR
 * on-chain (AERO price × gauge emission rate ÷ TVL) is exactly the heavy
 * unverified math the recon ruled out. Instead this reads DefiLlama's
 * aggregate yields feed — unauthenticated, no SLA, like DexScreener — which
 * carries live `apy`/`tvlUsd` per pool plus the pool's `underlyingTokens`.
 *
 * Matching is by ADDRESS, never by name: a pool is ours only when its
 * underlying token set equals `{USDC, one registry token}`. That rule is
 * what excludes the live impostors (`WTNVDA`, `WTCOIN`, `COINAGE`), which
 * carry tempting symbols over unrelated contracts. Pool names, symbols and
 * reward-token fields are display-only and decide nothing.
 *
 * Nothing here names a transaction target. Pool and gauge addresses never
 * enter this module at all — the feed's own `pool` id is an opaque
 * DefiLlama key, not an address, and is dropped on the floor. The day a
 * real deposit ships, every address it touches goes through the full
 * address-verification discipline first.
 */

/** DefiLlama's aggregate yields feed. Unauthenticated and without an SLA. */
export const YIELDS_POOLS_URL = "https://yields.llama.fi/pools";

const REQUEST_TIMEOUT_MS = 12_000;

/** One Aerodrome LP behind a tradeable token, as the preview shows it. */
export type EarnPool = {
  symbol: QuotableSymbol;
  /** Total APR as read, fees plus emissions. An estimate that moves. */
  apy: number;
  /** Fee-only APR. Null when the feed did not split it out. */
  apyBase: number | null;
  /** Emissions APR. Null when the feed did not split it out. */
  apyReward: number | null;
  /** Pool TVL in USD. */
  tvlUsd: number;
};

/** Plain USDC lending, when the feed carries an unambiguous row for it. */
export type LendingRate = {
  venue: string;
  apy: number;
  tvlUsd: number;
};

export type EarnSnapshot = {
  pools: EarnPool[];
  lending: LendingRate | null;
  /** Unix ms of the read. Rendered as the freshness timestamp. */
  readAtMs: number;
};

export type EarnResult =
  | { kind: "rates"; snapshot: EarnSnapshot }
  /** The feed could not be read or held nothing usable. Retryable, never fatal. */
  | { kind: "failed"; detail: string };

export type FetchEarnOptions = {
  /** Injected in tests so the suite never touches the network. */
  fetchImpl?: typeof fetch;
  /** Injected so the freshness timestamp is assertable. */
  nowMs?: number;
};

/**
 * Reads the yields feed and matches it against the registry. Never throws:
 * a feed we cannot use is `failed` with the reason attached, and the page
 * renders that instead of numbers.
 */
export async function fetchEarnRates(
  options: FetchEarnOptions = {},
): Promise<EarnResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now();

  let response: Response;
  try {
    response = await fetchImpl(YIELDS_POOLS_URL, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    return { kind: "failed", detail: `request threw: ${describe(cause)}` };
  }

  if (!response.ok) {
    return { kind: "failed", detail: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return { kind: "failed", detail: `malformed JSON: ${describe(cause)}` };
  }

  const pools =
    typeof body === "object" && body !== null
      ? (body as { data?: unknown }).data
      : null;
  if (!Array.isArray(pools)) {
    return { kind: "failed", detail: "feed carried no pool list" };
  }

  const matched = matchEarnPools(pools);
  if (matched.pools.length === 0 && matched.lending === null) {
    return { kind: "failed", detail: "feed held no pool we could match" };
  }

  return {
    kind: "rates",
    snapshot: { ...matched, readAtMs: nowMs },
  };
}

type RawPool = Record<string, unknown>;

/**
 * The registry match, pure and covered offline.
 *
 * An entry becomes an `EarnPool` only when: it is a Base Aerodrome pool,
 * its underlying set is exactly `{USDC, one published token address}`, and
 * its APR and TVL read as finite non-negative numbers. Everything else —
 * wrong chain, wrong venue, impostor token, unreadable figure — is skipped
 * silently, because a yields feed is a long list we select from, not an
 * answer we trust. Two entries for one token resolve to the deeper TVL: the
 * pool people actually use.
 *
 * The lending row is deliberately narrower still: exactly `aave-v3`, exactly
 * `USDC`, underlying exactly `[USDC]`. A money-market line that needs
 * judgement calls is a line left out.
 */
export function matchEarnPools(entries: unknown[]): {
  pools: EarnPool[];
  lending: LendingRate | null;
} {
  const bySymbol = new Map<QuotableSymbol, EarnPool>();
  let lending: LendingRate | null = null;

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const pool = entry as RawPool;

    if (pool.chain !== "Base") continue;
    if (typeof pool.project !== "string") continue;

    const underlying = underlyingSet(pool.underlyingTokens);
    if (underlying === null) continue;

    if (pool.project === "aave-v3" && pool.symbol === "USDC" && underlying.size === 1) {
      const apy = toNonNegativeNumber(pool.apy);
      const tvlUsd = toNonNegativeNumber(pool.tvlUsd);
      if (apy === null || tvlUsd === null) continue;
      if (lending === null || tvlUsd > lending.tvlUsd) {
        lending = { venue: "Aave V3", apy, tvlUsd };
      }
      continue;
    }

    if (!pool.project.startsWith("aerodrome")) continue;
    if (underlying.size !== 2) continue;

    const symbol = symbolForUnderlying(underlying);
    if (symbol === null) continue;

    const apy = toNonNegativeNumber(pool.apy);
    const tvlUsd = toNonNegativeNumber(pool.tvlUsd);
    if (apy === null || tvlUsd === null) continue;

    const current = bySymbol.get(symbol);
    if (current !== undefined && current.tvlUsd >= tvlUsd) continue;

    bySymbol.set(symbol, {
      symbol,
      apy,
      apyBase: toOptionalNumber(pool.apyBase),
      apyReward: toOptionalNumber(pool.apyReward),
      tvlUsd,
    });
  }

  return { pools: [...bySymbol.values()], lending };
}

/** Lowercased address set, or null when the field is not an address list. */
function underlyingSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const set = new Set<string>();
  for (const token of value) {
    if (typeof token !== "string" || !token.startsWith("0x")) return null;
    set.add(token.toLowerCase());
  }
  return set;
}

/**
 * Which registry token completes the `{USDC, stock}` pair, if any.
 *
 * Compared lowercased on both sides: checksum casing is cosmetic on the
 * wire, and a valid match must not depend on it.
 */
function symbolForUnderlying(underlying: Set<string>): QuotableSymbol | null {
  if (!underlying.has(USDC_ADDRESS.toLowerCase())) return null;

  // Keys come from the registry object itself, so the cast is sound — the
  // same pattern `QUOTABLE_SYMBOLS` uses. No string from outside is tested
  // against the registry here.
  const entries = Object.entries(TOKEN_ADDRESSES) as Array<
    [QuotableSymbol, string]
  >;
  for (const [symbol, address] of entries) {
    if (underlying.has(address.toLowerCase())) return symbol;
  }
  return null;
}

/** Finite and non-negative, or null. An APR or TVL that is neither is unusable. */
function toNonNegativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** The optional APR split: absent or unreadable reads as unknown, never zero. */
function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return toNonNegativeNumber(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined;
}
