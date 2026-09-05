import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  AMOUNT_IN_MISMATCH_DETAIL,
  AMOUNT_OUT_SHORTFALL_DETAIL,
  AMOUNT_OUT_UNREADABLE_DETAIL,
  CALLDATA_MALFORMED_DETAIL,
  KYBERSWAP_BUILD_URL,
  MAX_SLIPPAGE_BPS,
  NO_ROUTE_DETAIL,
  PRICE_MOVED_DETAIL,
  SENDER_INVALID_DETAIL,
  SLIPPAGE_BPS,
  SLIPPAGE_INVALID_DETAIL,
  SWAP_DEADLINE_SEC,
  TRANSACTION_VALUE_DETAIL,
  buildSwap,
  isNoRoute,
  isPriceMoved,
  minAmountOutFor,
  parseBuildBody,
  parseSwapWire,
  prepareSwap,
  requestRoute,
  toSwapWire,
  type BuildParams,
  type BuildResult,
  type BuildSwapParams,
  type PrepareSwapParams,
  type SwapWireResult,
} from "@/lib/build";
import {
  KYBERSWAP_ROUTER_ADDRESS,
  KYBERSWAP_ROUTES_URL,
  MIN_QUOTE_USDC_UNITS,
  QUOTE_TTL_MS,
  ROUTER_ABSENT_DETAIL,
  ROUTER_MISMATCH_DETAIL,
  type Quote,
} from "@/lib/quote";
import { TOKEN_ADDRESSES, USDC_ADDRESS } from "@/lib/tokens";

/**
 * Offline throughout. Every test injects a stub `fetchImpl`, so nothing here
 * reaches KyberSwap and nothing depends on a route existing today.
 *
 * What these fixtures cannot prove is the wire shape they imitate — that comes
 * from KyberSwap's docs and a hand-read response. `verify/build.verify.ts` is what
 * checks it against the live endpoint, and it prints every field these tests
 * assume so a change upstream is visible rather than silent.
 */

const NVDA = TOKEN_ADDRESSES.NVDA;

/** $30, the reference ticket. 8 token decimals, so 5_000_000 units = 0.05 shares. */
const USDC_IN = 30_000_000n;
const UNITS_OUT = 5_000_000n;
const NOW = 1_757_000_000_000;

/**
 * The pinned router, not a fixture value — same reasoning as `lib/quote.test.ts`.
 * A test that spelled the address out would keep passing after the pin changed.
 */
const ROUTER = KYBERSWAP_ROUTER_ADDRESS;

/**
 * Senders, assembled from a repeating nibble rather than transcribed.
 *
 * No address literal enters the repo for a test's convenience: these are built
 * from a run of one byte and canonicalised by viem, so there is nothing to mistype
 * and nothing that could be mistaken for a real account. The body is all letters,
 * which is what makes the miscased variant below a genuine EIP-55 failure.
 */
const SENDER = getAddress(`0x${"ab".repeat(20)}`);
const SENDER_LOWER = `0x${"ab".repeat(20)}`;
const OTHER_ROUTER = getAddress(`0x${"22".repeat(20)}`);

/** The canonical sender with one nibble's case flipped: fails the checksum. */
const FIRST_NIBBLE = SENDER.slice(2, 3);
const SENDER_MISCASED = `0x${
  FIRST_NIBBLE === FIRST_NIBBLE.toUpperCase()
    ? FIRST_NIBBLE.toLowerCase()
    : FIRST_NIBBLE.toUpperCase()
}${SENDER.slice(3)}`;

/**
 * The floor under the quote the user was shown, derived the way the panel derives
 * it. Pinned as a literal *and* asserted against {@link minAmountOutFor} below, so
 * the arithmetic and the fixture cannot drift apart.
 */
const FLOOR = 4_975_000n;

/** `FLOOR` less another 50bps: the least a build may return before Guard 4 fires. */
const TOLERATED = 4_950_125n;

/** A selector plus three words of padding. Only ever shape-checked. */
const CALLDATA = `0xe21fd0e9${"00".repeat(96)}`;

type Fields = Record<string, unknown>;

/**
 * A `routeSummary` including fields we never read.
 *
 * `route` and `extra` are there to be handed back untouched: the build call takes
 * this object as the description of the route to encode, so a test that only
 * carried the fields we parse would not notice us dropping the rest.
 */
function summary(overrides: Fields = {}): Fields {
  return {
    tokenIn: USDC_ADDRESS,
    amountIn: USDC_IN.toString(),
    amountInUsd: "30",
    tokenOut: NVDA,
    amountOut: UNITS_OUT.toString(),
    amountOutUsd: "29.94",
    gas: "220000",
    gasUsd: "0.004",
    routerAddress: ROUTER,
    route: [[{ pool: "opaque-pool-id", swapAmount: "30000000" }]],
    extra: { chunksInfo: "opaque to us" },
    ...overrides,
  };
}

/** The `data` object of a build response. */
function built(overrides: Fields = {}): Fields {
  return {
    amountIn: USDC_IN.toString(),
    amountInUsd: "30",
    amountOut: UNITS_OUT.toString(),
    amountOutUsd: "29.94",
    gas: "220000",
    gasUsd: "0.004",
    data: CALLDATA,
    routerAddress: ROUTER,
    transactionValue: "0",
    ...overrides,
  };
}

/** The fixture minus one field, for the guards that fire on absence. */
function without(fields: Fields, key: string): Fields {
  const copy = { ...fields };
  delete copy[key];
  return copy;
}

type Call = { url: string; init: RequestInit | undefined };

/** A `fetch` that never leaves the process, plus the calls it recorded. */
function stub(handler: (url: string) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A 200 from the build endpoint, carrying `data` as given. */
function ok(data: Fields): Response {
  return json({ code: 0, message: "successfully", data });
}

/** A 200 from the routes endpoint, carrying a quotable route. */
function routed(overrides: Fields = {}): Response {
  return json({
    code: 0,
    message: "successfully",
    data: { routeSummary: summary(overrides), routerAddress: ROUTER },
  });
}

/** A stub that answers both endpoints the prepare path touches. */
function bothEndpoints(
  route: () => Response,
  build: () => Response,
): { fetchImpl: typeof fetch; calls: Call[] } {
  return stub((url) =>
    url.startsWith(KYBERSWAP_BUILD_URL) ? build() : route(),
  );
}

/** The quote a build is checked against. Never fetched here — handed in. */
function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "NVDA",
    usdcIn: USDC_IN,
    usdIn: 30,
    unitsOut: UNITS_OUT,
    shares: 0.05,
    usdPerShare: 600,
    executionCostBps: 20,
    gasUsd: 0.004,
    gasWei: 2_200_000_000_000n,
    routerAddress: ROUTER,
    receivedAtMs: NOW,
    expiresAtMs: NOW + QUOTE_TTL_MS,
    ...overrides,
  };
}

/** Narrows, and puts the refusal's own reason in the failure message. */
function expectTransaction(result: BuildResult) {
  if (result.kind !== "transaction") {
    throw new Error(
      `expected a transaction, got ${result.kind}: ${result.detail}`,
    );
  }
  return result.transaction;
}

function expectRefused(result: BuildResult): string {
  if (result.kind !== "refused") {
    throw new Error(`expected a refusal, got ${result.kind}`);
  }
  return result.detail;
}

function expectFailed(result: BuildResult): string {
  if (result.kind !== "failed") {
    throw new Error(`expected a failure, got ${result.kind}`);
  }
  return result.detail;
}

function onlyCall(calls: Call[]): Call {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) throw new Error("no request was made");
  return call;
}

/** The JSON body a recorded call sent. */
function sentBody(call: Call): Fields {
  const raw = call.init?.body;
  if (typeof raw !== "string") {
    throw new Error("build request carried no JSON body");
  }
  return JSON.parse(raw) as Fields;
}

/** `buildSwap` against one stubbed response, with the standard params. */
async function buildRun(
  handler: (url: string) => Response | Promise<Response>,
  overrides: Partial<BuildSwapParams> = {},
): Promise<{ result: BuildResult; calls: Call[] }> {
  const { fetchImpl, calls } = stub(handler);
  const result = await buildSwap(
    {
      quote: quote(),
      routeSummary: summary(),
      sender: SENDER,
      minAmountOut: FLOOR,
      ...overrides,
    },
    { fetchImpl, nowMs: NOW },
  );

  return { result, calls };
}

async function buildFor(
  handler: (url: string) => Response | Promise<Response>,
  overrides: Partial<BuildSwapParams> = {},
): Promise<BuildResult> {
  const { result } = await buildRun(handler, overrides);
  return result;
}

/** The detail of a refusal from one stubbed build response. */
async function refusalFor(data: Fields): Promise<string> {
  return expectRefused(await buildFor(() => ok(data)));
}

describe("minAmountOutFor", () => {
  it("takes the tolerance off the quoted amount", () => {
    expect(minAmountOutFor(UNITS_OUT, SLIPPAGE_BPS)).toBe(FLOOR);
    // Where `TOLERATED` comes from: the same operation applied to the floor is
    // what Guard 4 compares a build against.
    expect(minAmountOutFor(FLOOR, SLIPPAGE_BPS)).toBe(TOLERATED);
  });

  it("returns the amount unchanged at zero tolerance", () => {
    expect(minAmountOutFor(UNITS_OUT, 0)).toBe(UNITS_OUT);
  });

  it("rounds down, so the floor never overstates the protection", () => {
    // 101 less 50bps is 100.495. Rounding up would print a minimum the calldata
    // does not enforce.
    expect(minAmountOutFor(101n, SLIPPAGE_BPS)).toBe(100n);
  });

  it("refuses a tolerance above the band", () => {
    expect(minAmountOutFor(UNITS_OUT, MAX_SLIPPAGE_BPS + 1)).toBeNull();
  });

  it("refuses a fractional tolerance", () => {
    expect(minAmountOutFor(UNITS_OUT, 12.5)).toBeNull();
  });

  it("refuses a negative amount", () => {
    expect(minAmountOutFor(-1n, SLIPPAGE_BPS)).toBeNull();
  });
});

describe("buildSwap: the request", () => {
  it("posts to the Base build endpoint as JSON, with the client id", async () => {
    const { calls } = await buildRun(() => ok(built()));
    const call = onlyCall(calls);

    expect(call.url).toBe(KYBERSWAP_BUILD_URL);
    expect(call.init?.method).toBe("POST");

    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.["accept"]).toBe("application/json");
    expect(headers?.["content-type"]).toBe("application/json");
    // Asserted as present, not as a value: it is read from the environment.
    expect(headers?.["x-client-id"]).toBeTruthy();
    // Same identity in the body as in the header, which is what `source` is for.
    expect(sentBody(call).source).toBe(headers?.["x-client-id"]);
  });

  it("hands the routeSummary back verbatim, fields we never read included", async () => {
    const { calls } = await buildRun(() => ok(built()));

    expect(sentBody(onlyCall(calls)).routeSummary).toEqual(summary());
  });

  it("sends the sender as its own recipient, canonicalised", async () => {
    const { calls } = await buildRun(() => ok(built()), {
      sender: SENDER_LOWER,
    });
    const body = sentBody(onlyCall(calls));

    // Lowercase in, checksummed out — one spelling downstream. And `recipient` is
    // the sender, which is the guarantee that a build cannot pay out elsewhere.
    expect(body.sender).toBe(SENDER);
    expect(body.recipient).toBe(SENDER);
  });

  it("sends the tolerance in bps and a deadline off the injected clock", async () => {
    const { calls } = await buildRun(() => ok(built()));
    const body = sentBody(onlyCall(calls));

    expect(body.slippageTolerance).toBe(SLIPPAGE_BPS);
    expect(body.deadline).toBe(NOW / 1000 + SWAP_DEADLINE_SEC);
  });

  it("sends a caller's tolerance when one is given", async () => {
    const { calls } = await buildRun(() => ok(built()), { slippageBps: 120 });

    expect(sentBody(onlyCall(calls)).slippageTolerance).toBe(120);
  });

  it("refuses a sender that fails its checksum without spending a request", async () => {
    const { result, calls } = await buildRun(() => ok(built()), {
      sender: SENDER_MISCASED,
    });

    expect(expectRefused(result)).toContain(SENDER_INVALID_DETAIL);
    expect(calls).toHaveLength(0);
  });

  it("refuses the zero address as a sender", async () => {
    const { result, calls } = await buildRun(() => ok(built()), {
      sender: `0x${"0".repeat(40)}`,
    });

    expect(expectRefused(result)).toContain(SENDER_INVALID_DETAIL);
    expect(calls).toHaveLength(0);
  });

  it("refuses a tolerance outside the band without spending a request", async () => {
    const { result, calls } = await buildRun(() => ok(built()), {
      slippageBps: MAX_SLIPPAGE_BPS + 1,
    });

    expect(expectRefused(result)).toContain(SLIPPAGE_INVALID_DETAIL);
    expect(calls).toHaveLength(0);
  });
});

describe("buildSwap: the transaction", () => {
  it("returns an unsigned transaction the panel can read every field of", async () => {
    const tx = expectTransaction(await buildFor(() => ok(built())));

    expect(tx.symbol).toBe("NVDA");
    expect(tx.to).toBe(ROUTER);
    expect(tx.data).toBe(CALLDATA);
    expect(tx.value).toBe("0");
    expect(tx.amountIn).toBe(USDC_IN);
    expect(tx.amountOut).toBe(UNITS_OUT);
    // Derived here from `amountOut`, not read off the response.
    expect(tx.minAmountOut).toBe(FLOOR);
    expect(tx.slippageBps).toBe(SLIPPAGE_BPS);
    expect(tx.gas).toBe(220_000n);
    expect(tx.deadline).toBe(NOW / 1000 + SWAP_DEADLINE_SEC);
    // The quote's clock, carried through: the panel counts one expiry, not two.
    expect(tx.expiresAt).toBe(NOW + QUOTE_TTL_MS);
  });

  it("sends to the pinned router, not the address the response echoed", async () => {
    const tx = expectTransaction(
      await buildFor(() => ok(built({ routerAddress: ROUTER.toLowerCase() }))),
    );

    // Same address, different casing, and `to` is still our constant. Nothing a
    // response says chooses where calldata is sent.
    expect(tx.to).toBe(ROUTER);
  });

  it("reports gas as unknown rather than zero when the build omits it", async () => {
    const tx = expectTransaction(await buildFor(() => ok(without(built(), "gas"))));

    expect(tx.gas).toBeNull();
  });

  it("accepts a build that returns exactly the tolerated minimum", async () => {
    const tx = expectTransaction(
      await buildFor(() => ok(built({ amountOut: TOLERATED.toString() }))),
    );

    expect(tx.amountOut).toBe(TOLERATED);
    // The floor moves with the amount actually built, so it is still ours.
    expect(tx.minAmountOut).toBe(4_925_374n);
  });
});

describe("buildSwap: the guards", () => {
  it("refuses a build that names no router", async () => {
    const detail = await refusalFor(without(built(), "routerAddress"));

    expect(detail).toContain(ROUTER_ABSENT_DETAIL);
  });

  it("refuses a build that names a router other than the pin", async () => {
    const detail = await refusalFor(built({ routerAddress: OTHER_ROUTER }));

    expect(detail).toContain(ROUTER_MISMATCH_DETAIL);
    expect(detail).toContain(OTHER_ROUTER);
  });

  it("refuses a build that does not state amountIn at all", async () => {
    const detail = await refusalFor(without(built(), "amountIn"));

    expect(detail).toContain(AMOUNT_IN_MISMATCH_DETAIL);
  });

  it("refuses a build that states a different amountIn", async () => {
    const detail = await refusalFor(built({ amountIn: "29000000" }));

    expect(detail).toContain(AMOUNT_IN_MISMATCH_DETAIL);
    expect(detail).toContain("29000000");
  });

  it("refuses an unreadable amountOut", async () => {
    const detail = await refusalFor(built({ amountOut: "5.0e6" }));

    expect(detail).toContain(AMOUNT_OUT_UNREADABLE_DETAIL);
  });

  it("refuses a build that returns nothing", async () => {
    const detail = await refusalFor(built({ amountOut: "0" }));

    expect(detail).toContain(AMOUNT_OUT_UNREADABLE_DETAIL);
  });

  it("refuses a build one unit below the tolerated floor", async () => {
    const detail = await refusalFor(
      built({ amountOut: (TOLERATED - 1n).toString() }),
    );

    // The boundary is the point: one unit higher passes, in the test above. A
    // guard that refused every adverse tick would refuse the tolerance itself.
    expect(detail).toContain(AMOUNT_OUT_SHORTFALL_DETAIL);
    expect(detail).toContain(TOLERATED.toString());
  });

  it("refuses a transaction that would send ETH", async () => {
    const detail = await refusalFor(built({ transactionValue: "1" }));

    expect(detail).toContain(TRANSACTION_VALUE_DETAIL);
  });

  it("refuses a build that does not state a transaction value", async () => {
    const detail = await refusalFor(without(built(), "transactionValue"));

    expect(detail).toContain(TRANSACTION_VALUE_DETAIL);
  });

  it("refuses calldata with an odd number of hex characters", async () => {
    const detail = await refusalFor(built({ data: `${CALLDATA}0` }));

    expect(detail).toContain(CALLDATA_MALFORMED_DETAIL);
  });

  it("refuses a bare 0x, which would call the router with no selector", async () => {
    const detail = await refusalFor(built({ data: "0x" }));

    expect(detail).toContain(CALLDATA_MALFORMED_DETAIL);
  });

  it("refuses calldata that is not hex", async () => {
    const detail = await refusalFor(built({ data: "0xnothexatall" }));

    expect(detail).toContain(CALLDATA_MALFORMED_DETAIL);
  });

  it("refuses calldata that is not a string", async () => {
    const detail = await refusalFor(built({ data: 1234 }));

    expect(detail).toContain(CALLDATA_MALFORMED_DETAIL);
    expect(detail).toContain("number");
  });

  it("describes bad calldata instead of dumping it into the log", async () => {
    const detail = await refusalFor(built({ data: `${CALLDATA}0` }));

    // A refusal detail ends up in a server log, and real calldata runs to
    // kilobytes. Length plus the selector is what a person debugging this reads.
    expect(detail).toContain("starting 0xe21fd0e9");
    expect(detail).not.toContain(CALLDATA);
    expect(detail.length).toBeLessThan(80);
  });
});

describe("buildSwap: failures we could not read", () => {
  it("fails on a non-200", async () => {
    const detail = expectFailed(await buildFor(() => json({}, 500)));

    expect(detail).toBe("HTTP 500");
  });

  it("fails on a body that is not JSON", async () => {
    const detail = expectFailed(
      await buildFor(() => new Response("<html>gateway</html>")),
    );

    expect(detail).toContain("malformed JSON");
  });

  it("fails when the request throws", async () => {
    const detail = expectFailed(
      await buildFor(() => {
        throw new Error("socket hang up");
      }),
    );

    expect(detail).toContain("socket hang up");
  });

  it("fails on a non-zero aggregator code, carrying its message", async () => {
    const detail = expectFailed(
      await buildFor(() => json({ code: 4009, message: "route expired" })),
    );

    expect(detail).toBe("route expired");
  });

  it("fails when the response carries no data object", async () => {
    const detail = expectFailed(await buildFor(() => json({ code: 0 })));

    expect(detail).toContain("no data object");
  });
});

describe("requestRoute", () => {
  it("returns the quote and the summary that priced it, verbatim", async () => {
    const { fetchImpl } = stub(() => routed());
    const { result, routeSummary } = await requestRoute("NVDA", USDC_IN, {
      fetchImpl,
      nowMs: NOW,
    });

    expect(result.kind).toBe("quote");
    // Every field, including the ones only KyberSwap reads. This is the object
    // the build call is entitled to get back unchanged.
    expect(routeSummary).toEqual(summary());
  });

  it("carries no summary when there was no route to price", async () => {
    const { fetchImpl } = stub(() => json({}, 404));
    const { result, routeSummary } = await requestRoute("NVDA", USDC_IN, {
      fetchImpl,
      nowMs: NOW,
    });

    expect(result.kind).toBe("no-liquidity");
    expect(routeSummary).toBeNull();
  });
});

/** `prepareSwap` against a stubbed routes endpoint and a stubbed build endpoint. */
async function prepareRun(
  route: () => Response,
  build: () => Response,
  overrides: Partial<PrepareSwapParams> = {},
): Promise<{ result: BuildResult; calls: Call[] }> {
  const { fetchImpl, calls } = bothEndpoints(route, build);
  const result = await prepareSwap(
    {
      symbol: "NVDA",
      usdcIn: USDC_IN,
      sender: SENDER,
      minAmountOut: FLOOR,
      ...overrides,
    },
    { fetchImpl, nowMs: NOW },
  );

  return { result, calls };
}

describe("prepareSwap", () => {
  it("quotes first, then builds, once each", async () => {
    const { result, calls } = await prepareRun(
      () => routed(),
      () => ok(built()),
    );

    expectTransaction(result);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.startsWith(KYBERSWAP_ROUTES_URL)).toBe(true);
    expect(calls[1]?.url).toBe(KYBERSWAP_BUILD_URL);
  });

  it("builds against the fresh quote's amount and expiry", async () => {
    const { result } = await prepareRun(
      () => routed(),
      () => ok(built()),
    );
    const tx = expectTransaction(result);

    expect(tx.amountIn).toBe(USDC_IN);
    expect(tx.amountOut).toBe(UNITS_OUT);
    expect(tx.expiresAt).toBe(NOW + QUOTE_TTL_MS);
  });

  it("refuses with price-moved when the route now returns less than the floor", async () => {
    const { result, calls } = await prepareRun(
      () => routed({ amountOut: "4900000" }),
      () => ok(built()),
    );

    // Below the floor the user was shown, so no build call is spent on it: the
    // answer is a fresh quote, not a worse trade wearing the old number.
    expect(expectRefused(result)).toContain(PRICE_MOVED_DETAIL);
    expect(isPriceMoved(result)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("builds when the price moved in the user's favour", async () => {
    const { result } = await prepareRun(
      () => routed({ amountOut: "5100000" }),
      () => ok(built({ amountOut: "5100000" })),
    );

    expect(expectTransaction(result).amountOut).toBe(5_100_000n);
  });

  it("refuses with no-route when the aggregator has none at this size", async () => {
    const { result, calls } = await prepareRun(
      () => json({}, 404),
      () => ok(built()),
    );

    expect(expectRefused(result)).toContain(NO_ROUTE_DETAIL);
    expect(isNoRoute(result)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("passes a quote failure through as failed, without building", async () => {
    const { result, calls } = await prepareRun(
      () => json({}, 500),
      () => ok(built()),
    );

    expect(expectFailed(result)).toContain("500");
    expect(calls).toHaveLength(1);
  });

  it("canonicalises the sender on the way to the build body", async () => {
    const { calls } = await prepareRun(
      () => routed(),
      () => ok(built()),
      { sender: SENDER_LOWER },
    );

    const build = calls[1];
    if (build === undefined) throw new Error("no build request was made");

    expect(sentBody(build).sender).toBe(SENDER);
    expect(sentBody(build).recipient).toBe(SENDER);
  });
});

describe("the refusal predicates", () => {
  it("do not fire on a transaction", async () => {
    const result = await buildFor(() => ok(built()));

    expect(isPriceMoved(result)).toBe(false);
    expect(isNoRoute(result)).toBe(false);
  });

  it("do not fire on a refusal that is not theirs", async () => {
    const result = await buildFor(() => ok(built({ transactionValue: "1" })));

    expect(isPriceMoved(result)).toBe(false);
    expect(isNoRoute(result)).toBe(false);
  });
});

/** The JSON body `/api/build` is posted, as the panel would post it. */
function posted(overrides: Fields = {}): Fields {
  return {
    symbol: "NVDA",
    amountIn: USDC_IN.toString(),
    sender: SENDER,
    minAmountOut: FLOOR.toString(),
    ...overrides,
  };
}

function expectAccepted(params: BuildParams) {
  if (!params.ok) {
    throw new Error(`expected the body to parse: ${params.reason}`);
  }
  return params;
}

function expectRejected(params: BuildParams): string {
  if (params.ok) throw new Error("expected the body to be rejected");
  return params.reason;
}

/** The reason one body was rejected for. */
function rejection(body: unknown): string {
  return expectRejected(parseBuildBody(body));
}

/** What every accepted body above should parse to. */
const PARSED = {
  ok: true,
  symbol: "NVDA",
  usdcIn: USDC_IN,
  sender: SENDER,
  minAmountOut: FLOOR,
};

describe("parseBuildBody", () => {
  it("returns the four fields as the build path wants them", () => {
    expect(parseBuildBody(posted())).toEqual(PARSED);
  });

  it("canonicalises the sender", () => {
    const body = posted({ sender: SENDER_LOWER });

    expect(expectAccepted(parseBuildBody(body)).sender).toBe(SENDER);
  });

  it("carries no recipient, whatever the body asked for", () => {
    // Checked with `toEqual` on the whole object rather than by reading a field:
    // the assertion is that no fifth key survives, so a `recipient` added to the
    // parser later fails here before it can reach a build request.
    expect(parseBuildBody(posted({ recipient: OTHER_ROUTER }))).toEqual(PARSED);
  });

  it("rejects a body that is not an object", () => {
    expect(rejection("NVDA")).toContain("JSON object");
    expect(rejection(null)).toContain("JSON object");
  });

  it("rejects a symbol that is not a listed stock", () => {
    expect(rejection(posted({ symbol: "ZZZZ" }))).toContain("symbol");
    expect(rejection(without(posted(), "symbol"))).toContain("symbol");
  });

  it("rejects a listed stock we hold no address for, by name", () => {
    // A stock we know but cannot quote and a string that is not a stock are
    // different mistakes, and the message says which one happened.
    expect(rejection(posted({ symbol: "MSFT" }))).toContain("MSFT");
  });

  it("rejects an amountIn that is not a string of digits", () => {
    expect(rejection(posted({ amountIn: 30_000_000 }))).toContain("amountIn");
    expect(rejection(without(posted(), "amountIn"))).toContain("amountIn");
  });

  it("applies the quote path's band rather than a second copy of it", () => {
    const under = (MIN_QUOTE_USDC_UNITS - 1n).toString();

    // The bound in the message is the quote path's own constant, which is the
    // evidence that this validator delegates instead of restating.
    expect(rejection(posted({ amountIn: under }))).toContain(
      MIN_QUOTE_USDC_UNITS.toString(),
    );
  });

  it("rejects a sender that fails its checksum", () => {
    expect(rejection(posted({ sender: SENDER_MISCASED }))).toContain("sender");
  });

  it("rejects the zero address and a missing sender", () => {
    expect(rejection(posted({ sender: `0x${"0".repeat(40)}` }))).toContain(
      "sender",
    );
    expect(rejection(without(posted(), "sender"))).toContain("sender");
  });

  it("rejects a floor of zero, which would be no floor at all", () => {
    expect(rejection(posted({ minAmountOut: "0" }))).toContain("minAmountOut");
  });

  it("rejects a negative, fractional or JSON-number floor", () => {
    for (const value of ["-1", "4.975", "5e6", 4_975_000]) {
      expect(rejection(posted({ minAmountOut: value }))).toContain(
        "minAmountOut",
      );
    }
  });

  it("rejects a floor too long to be worth converting", () => {
    const digits = "9".repeat(25);

    expect(rejection(posted({ minAmountOut: digits }))).toContain(
      "minAmountOut",
    );
  });
});

describe("toSwapWire", () => {
  it("carries exactly the fields the browser is given", async () => {
    const tx = expectTransaction(await buildFor(() => ok(built())));
    const wire = toSwapWire(tx);

    // Pinned as a set, because this is the contract with the panel: a field added
    // here is a field the browser starts trusting.
    expect(Object.keys(wire).sort()).toEqual([
      "amountOut",
      "data",
      "expiresAt",
      "gas",
      "kind",
      "minAmountOut",
      "to",
      "value",
    ]);
  });

  it("sends amounts as decimal strings, since bigint does not survive JSON", async () => {
    const tx = expectTransaction(await buildFor(() => ok(built())));

    expect(toSwapWire(tx)).toEqual({
      kind: "transaction",
      to: ROUTER,
      data: CALLDATA,
      value: "0",
      amountOut: UNITS_OUT.toString(),
      minAmountOut: FLOOR.toString(),
      gas: "220000",
      expiresAt: NOW + QUOTE_TTL_MS,
    });
  });

  it("keeps an unknown gas estimate null rather than sending zero", async () => {
    const tx = expectTransaction(
      await buildFor(() => ok(without(built(), "gas"))),
    );

    expect(toSwapWire(tx).gas).toBeNull();
  });
});

/**
 * The last checks before a signature, tested where they can be: `hooks/useTrade.ts`
 * calls this immediately before `sendTransaction`, and there is no jsdom here to
 * render a hook in.
 *
 * The fixture is a real `toSwapWire` output rather than a hand-written object, so the
 * happy path cannot pass against a shape the server does not actually send.
 */
describe("parseSwapWire", () => {
  /** A genuine wire payload, after a JSON round trip, with any field replaceable. */
  async function wire(overrides: Fields = {}): Promise<Fields> {
    const tx = expectTransaction(await buildFor(() => ok(built())));
    const sent = JSON.parse(JSON.stringify(toSwapWire(tx))) as Fields;

    return { ...sent, ...overrides };
  }

  function expectUnsafe(result: SwapWireResult): string {
    if (result.kind !== "unsafe") {
      throw new Error(`expected a refusal, got ${result.kind}`);
    }
    return result.detail;
  }

  it("reads a real payload back into amounts a wallet can be handed", async () => {
    const result = parseSwapWire(await wire());

    expect(result).toEqual({
      kind: "transaction",
      transaction: {
        to: ROUTER,
        data: CALLDATA,
        value: "0",
        amountOut: UNITS_OUT,
        minAmountOut: FLOOR,
        gas: 220_000n,
        expiresAt: NOW + QUOTE_TTL_MS,
      },
    });
  });

  it("refuses a router that is not the pin", async () => {
    // The one that matters most. `to` is what a signature authorises, and a
    // tampered one is a user's whole USDC allowance handed to someone else.
    const detail = expectUnsafe(parseSwapWire(await wire({ to: OTHER_ROUTER })));

    expect(detail).toContain(ROUTER_MISMATCH_DETAIL);
    expect(detail).toContain(OTHER_ROUTER);
  });

  it("refuses a payload that names no router at all", async () => {
    for (const to of [undefined, null, 7, ROUTER.toLowerCase().slice(0, 20)]) {
      const result = parseSwapWire(await wire({ to }));

      // Absence and a wrong value are both refusals, never a default.
      expect(result.kind, String(to)).toBe("unsafe");
    }
  });

  it("accepts the pin in any casing and hands back our own constant", async () => {
    const result = parseSwapWire(await wire({ to: ROUTER.toLowerCase() }));

    if (result.kind !== "transaction") {
      throw new Error(`expected a transaction, got ${result.kind}`);
    }

    // Checksum casing is cosmetic, so a lowercased echo is the same address — and
    // what comes back is the constant from the repo, not the string checked.
    expect(result.transaction.to).toBe(ROUTER);
  });

  it("refuses a swap that would send ETH", async () => {
    // Every one of these is falsy or coerces to zero. A `!value` test would have
    // passed all of them.
    for (const sent of [undefined, null, 0, "0x0", "", "1", "1000000000000000"]) {
      const detail = expectUnsafe(parseSwapWire(await wire({ value: sent })));

      expect(detail, String(sent)).toContain(TRANSACTION_VALUE_DETAIL);
    }
  });

  it("refuses calldata that is not whole bytes of hex", async () => {
    for (const data of [undefined, "0x", "0xabc", "not-hex", 7]) {
      const detail = expectUnsafe(parseSwapWire(await wire({ data })));

      expect(detail, String(data)).toContain(CALLDATA_MALFORMED_DETAIL);
    }
  });

  it("refuses a floor above the amount the payload itself quotes", async () => {
    const detail = expectUnsafe(
      parseSwapWire(
        await wire({
          amountOut: UNITS_OUT.toString(),
          minAmountOut: (UNITS_OUT + 1n).toString(),
        }),
      ),
    );

    expect(detail).toContain(AMOUNT_OUT_SHORTFALL_DETAIL);
  });

  it("reads an unusable payload as unreadable rather than unsafe", async () => {
    // The distinction the panel acts on: this half is worth retrying, and the
    // refusals above are not.
    for (const value of [null, undefined, "transaction", 7, [], {}]) {
      expect(parseSwapWire(value).kind, String(value)).toBe("unreadable");
    }

    for (const key of ["amountOut", "minAmountOut", "expiresAt"]) {
      expect(parseSwapWire(without(await wire(), key)).kind, key).toBe(
        "unreadable",
      );
    }

    expect(parseSwapWire(await wire({ amountOut: "0" })).kind).toBe("unreadable");
  });

  it("keeps an absent gas estimate null", async () => {
    const result = parseSwapWire(await wire({ gas: null }));

    if (result.kind !== "transaction") {
      throw new Error(`expected a transaction, got ${result.kind}`);
    }

    // Null, not zero. The panel renders it as no estimate, and CLAUDE.md wants gas
    // visible — a zero would be visible and wrong.
    expect(result.transaction.gas).toBeNull();
  });
});
