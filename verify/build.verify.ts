import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  KYBERSWAP_BUILD_URL,
  SLIPPAGE_BPS,
  SWAP_DEADLINE_SEC,
  buildSwap,
  minAmountOutFor,
  requestRoute,
} from "@/lib/build";
import { KYBERSWAP_ROUTER_ADDRESS, clientId, sameAddress } from "@/lib/quote";
import { sleep } from "@/lib/rpc";
import { TOKEN_ADDRESSES } from "@/lib/tokens";
import { PROBE_USDC_UNITS } from "@/lib/tradeability";

/**
 * The KyberSwap build endpoint, against the live API.
 *
 * Not part of `npm test`. Real third-party requests, so it sits behind
 * `npm run verify:build` and is run deliberately — after a change to the build
 * request, to any of its guards, or to the router pin.
 *
 * NO FUNDS, NO WALLET, NO SIGNATURE. This asks the aggregator to encode a swap and
 * then throws the calldata away. Nothing is signed, so nothing can be submitted:
 * unsigned calldata is inert, and the placeholder sender below holds no key, no ETH
 * and no USDC. What is being checked is the shape of an answer, not a trade.
 *
 * Why it exists. `lib/build.ts` refuses a build that disagrees with the quote it
 * came from, and every one of those refusals is coded against field names that came
 * from KyberSwap's docs. `lib/build.test.ts` pins the guards against a fixture,
 * which proves the logic and says nothing about whether the fixture still resembles
 * the API. A rename upstream turns `amountOut` into `undefined`, and the guards then
 * fail closed on every buy — correct behaviour, and invisible until someone reads a
 * log. This file prints what actually comes back so the fixture can be corrected.
 *
 * The assertion meant to break one day is the router. `KYBERSWAP_ROUTER_ADDRESS` is
 * the spender a user's USDC allowance names and the `to` of every transaction we
 * hand a wallet, so if KyberSwap redeploys, the app stops building entirely rather
 * than sending calldata to an address a response chose. This is where the new
 * address gets read and checked before the pin moves. Never copy it out of a
 * response.
 */

/** A second between requests. Nothing here is in a hurry. */
const DELAY_MS = 1_000;

/**
 * A placeholder sender: a well-formed address assembled from one repeated byte.
 *
 * Not transcribed from anywhere and not an account — no address literal enters the
 * repo for a script's convenience. The build endpoint needs a sender to encode a
 * `recipient` against, and that is the whole of its role here.
 */
const SENDER = getAddress(`0x${"ab".repeat(20)}`);

/** The fields `interpretBuild` reads, and what happens without each. */
const MAPPED_FIELDS: ReadonlyArray<readonly [string, string]> = [
  [
    "routerAddress",
    "the router guard fails closed, so no swap can be built at all",
  ],
  [
    "amountIn",
    "the echo guard fails closed: nothing confirms the build spends what we quoted",
  ],
  [
    "amountOut",
    "there is no amount to derive minAmountOut from, so every build is refused",
  ],
  ["data", "there is no calldata, so there is nothing for a wallet to sign"],
  [
    "transactionValue",
    "the zero-value guard fails closed: nothing confirms the swap sends no ETH",
  ],
  ["gas", "estimated gas goes blank, which CLAUDE.md requires visible"],
];

/** The envelope, as far as the mapping cares about it. */
type BuildBody = {
  code?: unknown;
  message?: unknown;
  data?: Record<string, unknown>;
};

/** Parses the envelope, printing whatever came back if it is not JSON. */
function parseBody(raw: string, status: number): BuildBody {
  try {
    return JSON.parse(raw) as BuildBody;
  } catch {
    console.info(`  HTTP ${status}, not JSON: ${raw.slice(0, 300)}`);
    throw new Error(`the build endpoint answered HTTP ${status} with non-JSON`);
  }
}

/**
 * Calldata as a line of log: how long it is and which function it calls.
 *
 * The bytes themselves are never printed. Real route calldata runs to kilobytes,
 * and the two things worth reading with your own eyes are the length — proof it is
 * not a truncated stub — and the selector, which is the one part of an opaque blob
 * that says what the transaction would do.
 */
function describeCalldata(data: string): string {
  const bytes = (data.length - 2) / 2;

  return `${bytes} bytes, selector ${data.slice(0, 10)}`;
}

/**
 * The whole path a buy takes, minus the signature.
 *
 * Quote, derive the floor the user would have been shown, then build against it —
 * the same two calls in the same order as `/api/build`, so a break here is a break
 * in the flow rather than in a fixture.
 */
describe("a $30 NVDA route, built end to end", () => {
  it(`builds calldata for ${TOKEN_ADDRESSES.NVDA}`, async () => {
    await sleep(DELAY_MS);

    const { result, routeSummary } = await requestRoute(
      "NVDA",
      PROBE_USDC_UNITS,
    );

    if (result.kind === "no-liquidity") {
      // Depth follows weekly Aerodrome gauge votes. No route for $30 of NVDA today
      // is news about Base rather than a broken build, and `verify:quote` is where
      // a missing route is judged.
      console.info(`  no route today: ${result.detail}`);
      return;
    }

    expect(result.kind, result.kind === "quote" ? "" : result.detail).toBe(
      "quote",
    );
    if (result.kind !== "quote") return;

    expect(
      routeSummary,
      "a priced route with no routeSummary: there is nothing to build from",
    ).not.toBeNull();
    if (routeSummary === null) return;

    const { quote } = result;
    const floor = minAmountOutFor(quote.unitsOut, SLIPPAGE_BPS);
    if (floor === null) {
      throw new Error(`${quote.unitsOut} units has no floor at ${SLIPPAGE_BPS}bps`);
    }

    console.info(
      `  quoted ${quote.shares} shares (${quote.unitsOut} units), floor ${floor} at ${SLIPPAGE_BPS}bps`,
    );

    await sleep(DELAY_MS);

    const built = await buildSwap({
      quote,
      routeSummary,
      sender: SENDER,
      minAmountOut: floor,
    });

    expect(
      built.kind,
      built.kind === "transaction" ? "" : built.detail,
    ).toBe("transaction");
    if (built.kind !== "transaction") return;

    const tx = built.transaction;
    const gas = tx.gas === null ? "no estimate" : `${tx.gas} units`;

    console.info(`  to            ${tx.to}`);
    console.info(`  value         ${tx.value}`);
    console.info(`  amountIn      ${tx.amountIn} USDC units`);
    console.info(`  amountOut     ${tx.amountOut} token units`);
    console.info(`  minAmountOut  ${tx.minAmountOut} (ours, at ${tx.slippageBps}bps)`);
    console.info(`  gas           ${gas}`);
    console.info(`  deadline      ${tx.deadline} (unix seconds)`);
    console.info(`  calldata      ${describeCalldata(tx.data)}`);

    // The pin, not the echo. `interpretBuild` already refused any other router, so
    // this restates the guarantee as an assertion: a change that loosened the guard
    // would fail here as well as offline.
    expect(tx.to, "to is not the pinned router").toBe(KYBERSWAP_ROUTER_ADDRESS);
    expect(tx.value, "a swap that would send ETH").toBe("0");
    expect(tx.amountIn, "amountIn echo").toBe(PROBE_USDC_UNITS);
    expect(tx.amountOut > 0n, "amountOut").toBe(true);
    expect(tx.minAmountOut, "minAmountOut is not ours").toBe(
      minAmountOutFor(tx.amountOut, SLIPPAGE_BPS),
    );
    expect(tx.data, "calldata is not whole bytes of hex").toMatch(
      /^0x([0-9a-fA-F]{2})+$/,
    );
    expect(tx.deadline, "the deadline is already past").toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
  });
});

/**
 * One field as a line of log, with calldata summarised rather than dumped.
 *
 * `String` on an object gives `[object Object]`, which is the right answer here:
 * none of the six mapped fields is one, so seeing it is the news.
 */
function describeValue(field: string, value: unknown): string {
  if (field === "data" && typeof value === "string" && value.startsWith("0x")) {
    return describeCalldata(value);
  }

  return value === undefined ? "MISSING" : String(value);
}

/**
 * The response as it arrives, before `interpretBuild` has an opinion about it.
 *
 * The same request the library makes, posted by hand, so the log shows the field
 * names and types the mapping is coded against. Assertions are strict on purpose: a
 * field that changed type is a break in the mapping, and this file exists to find
 * one before a user does.
 */
describe("the build response, field by field", () => {
  it(`maps what ${KYBERSWAP_BUILD_URL} returns`, async () => {
    await sleep(DELAY_MS);

    const { result, routeSummary } = await requestRoute(
      "NVDA",
      PROBE_USDC_UNITS,
    );

    if (result.kind === "no-liquidity") {
      console.info(`  no route today: ${result.detail}`);
      return;
    }

    expect(result.kind, result.kind === "quote" ? "" : result.detail).toBe(
      "quote",
    );
    expect(routeSummary, "a priced route with no routeSummary").not.toBeNull();
    if (result.kind !== "quote" || routeSummary === null) return;

    await sleep(DELAY_MS);

    const deadline = Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SEC;

    const response = await fetch(KYBERSWAP_BUILD_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": clientId(),
      },
      body: JSON.stringify({
        routeSummary,
        sender: SENDER,
        recipient: SENDER,
        slippageTolerance: SLIPPAGE_BPS,
        deadline,
        source: clientId(),
      }),
      // A hang would otherwise be reported as the test timing out, which reads as a
      // broken test rather than an endpoint that never answered.
      signal: AbortSignal.timeout(15_000),
    });

    const body = parseBody(await response.text(), response.status);

    console.info(
      `  HTTP ${response.status}, code ${String(body.code)}, message ${String(body.message)}`,
    );
    console.info(`  deadline sent ${deadline} (unix seconds)`);

    expect(
      response.ok,
      `the build endpoint answered HTTP ${response.status}`,
    ).toBe(true);

    // Widened to `unknown` so both guards below narrow it honestly: the envelope
    // type is a cast over `JSON.parse`, and a cast is not a promise.
    const envelope: unknown = body.data;
    expect(envelope, "no data object: the mapping has nothing to read").toBeTypeOf(
      "object",
    );
    if (typeof envelope !== "object" || envelope === null) return;

    const data = envelope as Record<string, unknown>;

    for (const [field, consequence] of MAPPED_FIELDS) {
      console.info(`  ${field.padEnd(17)}${describeValue(field, data[field])}`);
      expect(data, `${field} is gone: ${consequence}`).toHaveProperty(field);
    }

    // Strict on type as well as presence. `interpretBuild` reads `transactionValue`
    // by comparing it to the string `"0"`, so a field that became a number would
    // fail that guard closed on every buy — a break worth seeing here first.
    expect(data.transactionValue, "a swap that would send ETH").toBe("0");
    expect(data.amountIn, "amountIn no longer echoes what we asked to spend").toBe(
      PROBE_USDC_UNITS.toString(),
    );
    expect(
      String(data.amountOut),
      "amountOut is not a positive integer of token units",
    ).toMatch(/^[1-9][0-9]*$/);
    expect(String(data.data), "calldata is not whole bytes of hex").toMatch(
      /^0x([0-9a-fA-F]{2})+$/,
    );

    // The one assertion here that is meant to break one day. When KyberSwap
    // redeploys, this is the failure that says so, and the new address gets read
    // here — with human eyes, from a printed response — before the pin moves.
    // Never copy it across without that step.
    expect(
      sameAddress(data.routerAddress, KYBERSWAP_ROUTER_ADDRESS),
      `router moved: response says ${String(data.routerAddress)}, the pin says ${KYBERSWAP_ROUTER_ADDRESS}`,
    ).toBe(true);
  });
});
