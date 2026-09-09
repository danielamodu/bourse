import { describe, expect, it } from "vitest";

import {
  YIELDS_POOLS_URL,
  fetchEarnRates,
  matchEarnPools,
} from "@/lib/earn";
import { TOKEN_ADDRESSES, USDC_ADDRESS } from "@/lib/tokens";

/**
 * The earn match, pinned offline.
 *
 * Every test hands `matchEarnPools` a hand-built feed entry, so nothing here
 * reaches the network. What is pinned is the discipline: addresses decide,
 * names do not — the impostor entries below wear tempting symbols over
 * unrelated contracts and must lose to the registry every time.
 */

const NVDA_POOL = {
  pool: "f07ec582-f302-5fab-9531-eabc3f8f291c",
  chain: "Base",
  project: "aerodrome-slipstream",
  symbol: "USDC-NVDAC",
  tvlUsd: 2174310,
  apy: 307.26123,
  apyBase: 52.8662,
  apyReward: 254.39503,
  underlyingTokens: [USDC_ADDRESS, TOKEN_ADDRESSES.NVDA],
};

const AAVE_USDC = {
  pool: "7e0661bf-8cf3-45e6-9424-31916d4c7b84",
  chain: "Base",
  project: "aave-v3",
  symbol: "USDC",
  tvlUsd: 20202071,
  apy: 3.64456,
  apyBase: 3.64456,
  apyReward: null,
  underlyingTokens: [USDC_ADDRESS],
};

describe("matchEarnPools", () => {
  it("matches by underlying addresses, carrying the APR split through", () => {
    const { pools, lending } = matchEarnPools([NVDA_POOL, AAVE_USDC]);

    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      symbol: "NVDA",
      apy: 307.26123,
      apyBase: 52.8662,
      apyReward: 254.39503,
      tvlUsd: 2174310,
    });
    expect(lending).toMatchObject({ venue: "Aave V3", apy: 3.64456 });
  });

  it("rejects impostor symbols over unrelated contracts", () => {
    // Live shape, seen in the recon: tempting name, wrong token.
    const impostors = [
      {
        ...NVDA_POOL,
        pool: "impostor-1",
        symbol: "USDC-WTNVDA",
        underlyingTokens: [
          USDC_ADDRESS,
          "0xFb5B41acdbA20a3230F84BE995173CFb98b8D6E7",
        ],
      },
      {
        ...NVDA_POOL,
        pool: "impostor-2",
        symbol: "USDC-NVDAC",
        underlyingTokens: [USDC_ADDRESS, USDC_ADDRESS],
      },
    ];

    expect(matchEarnPools(impostors).pools).toHaveLength(0);
  });

  it("ignores the wrong chain, the wrong venue and unreadable figures", () => {
    const entries = [
      { ...NVDA_POOL, chain: "Ethereum" },
      { ...NVDA_POOL, project: "uniswap-v3" },
      { ...NVDA_POOL, apy: "high" },
      { ...NVDA_POOL, tvlUsd: -5 },
      { ...NVDA_POOL, underlyingTokens: "USDC,NVDA" },
      null,
      "USDC-NVDAC",
    ];

    expect(matchEarnPools(entries).pools).toHaveLength(0);
  });

  it("resolves duplicate pools to the deeper TVL", () => {
    const shallow = { ...NVDA_POOL, pool: "shallow", tvlUsd: 10 };
    const { pools } = matchEarnPools([shallow, NVDA_POOL]);

    expect(pools).toHaveLength(1);
    expect(pools[0]?.tvlUsd).toBe(2174310);
  });

  it("reads a missing APR split as unknown, never zero", () => {
    const { pools } = matchEarnPools([{ ...NVDA_POOL, apyBase: null }]);

    expect(pools[0]?.apyBase).toBeNull();
  });

  it("holds the lending line to exactly aave-v3 USDC on USDC", () => {
    expect(
      matchEarnPools([{ ...AAVE_USDC, project: "morpho-blue" }]).lending,
    ).toBeNull();
    expect(
      matchEarnPools([{ ...AAVE_USDC, symbol: "STEAKUSDC" }]).lending,
    ).toBeNull();
    expect(
      matchEarnPools([
        { ...AAVE_USDC, underlyingTokens: [USDC_ADDRESS, TOKEN_ADDRESSES.NVDA] },
      ]).lending,
    ).toBeNull();
  });
});

describe("fetchEarnRates", () => {
  const stub = (body: () => Response) => {
    const fetchImpl = (() => Promise.resolve(body())) as unknown as typeof fetch;
    return { fetchImpl };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it("asks the yields feed and stamps the read", async () => {
    const calls: unknown[][] = [];
    const fetchImpl = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(json({ data: [NVDA_POOL] }));
    }) as unknown as typeof fetch;

    const result = await fetchEarnRates({ fetchImpl, nowMs: 1234 });

    expect(String(calls[0]?.[0])).toBe(YIELDS_POOLS_URL);
    expect(result.kind).toBe("rates");
    if (result.kind !== "rates") return;
    expect(result.snapshot.readAtMs).toBe(1234);
    expect(result.snapshot.pools).toHaveLength(1);
  });

  it("fails rather than renders on transport and garbage", async () => {
    expect(
      await fetchEarnRates(stub(() => new Response("", { status: 500 }))),
    ).toMatchObject({ kind: "failed" });
    expect(
      await fetchEarnRates(stub(() => new Response("nope", { status: 200 }))),
    ).toMatchObject({ kind: "failed" });
    expect(
      await fetchEarnRates(stub(() => json({ data: "pools" }))),
    ).toMatchObject({ kind: "failed" });
    expect(
      await fetchEarnRates(stub(() => json({ data: [] }))),
    ).toMatchObject({ kind: "failed" });
  });
});
