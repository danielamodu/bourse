import {
  decodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
} from "viem";
import { describe, expect, it } from "vitest";

import { SLIPPAGE_BPS, minAmountOutFor } from "@/lib/build";
import { KYBERSWAP_ROUTER_ADDRESS } from "@/lib/quote";
import {
  MULTICALL3_ADDRESS,
  READ_DELAY_MS,
  dedicatedRpcUrl,
  sleep,
} from "@/lib/rpc";
import { buildSellSwap, requestSellRoute } from "@/lib/sell";
import { TOKEN_ADDRESSES, TOKEN_DECIMALS } from "@/lib/tokens";

/**
 * The pinned router, executed for a SALE against live Base state — with no
 * funds, no wallet and no signature.
 *
 * The mirror of `verify/simulate.verify.ts`, with one settled difference.
 * That script funds its sender with `eth_call` state overrides against
 * USDC's storage. The same technique does NOT work here: step 2 of the first
 * version of this script proved it, failing loudly when none of slots 0..20
 * read back a positive `balanceOf` — B20 precompiles keep balances in native
 * client state, outside contract storage that `eth_getStorageAt` or
 * `stateDiff` can see. Overriding them is not a matter of finding the right
 * slot; there is no slot. So this script proves the sale a different honest
 * way:
 *
 * 1. Find a real approver mechanically: recent NVDA Transfer recipients are
 *    collected from `eth_getLogs` (topic derived with `encodeEventTopics`,
 *    never a literal hash), their `balanceOf` and their
 *    `allowance(recipient, pinned router)` are read back in two batched
 *    Multicall3 calls, and the first recipient holding enough stock with
 *    enough approval for the simulated size wins. No address is hardcoded
 *    and none is supplied.
 * 2. Build a fresh NVDA→USDC route for that sender — `recipient` is the
 *    sender, set server-side, so the proceeds would go back to them.
 * 3. Run the resulting `{ to, data, value }` twice as `eth_call`: once from
 *    the approver, which must succeed against live allowances and return
 *    non-empty data, and once from a synthetic sender with no funds, which
 *    must revert. No overrides anywhere — nothing is fabricated, so the
 *    pair proves the route executes rather than passing vacuously.
 *
 * No signature is needed at any point: `eth_call` never touches a key, and
 * nothing is submitted. Assert `to` equals KYBERSWAP_ROUTER_ADDRESS and
 * `value` is "0" as every other verify script does.
 *
 * Print the raw return data; the assertion stops at non-empty, with the
 * reason in a comment — no router ABI is pinned anywhere in the repo, and
 * decoding would mean assuming an encoding the response never stated.
 */

type Hex = `0x${string}`;

/** 0.01 NVDA shares, in token base units. Well inside the sell band. */
const SIM_TOKEN_UNITS = 1_000_000n;

/**
 * NVDA is quiet next to USDC, but the free-tier endpoint caps `eth_getLogs`
 * at 10 blocks per request — so the window is walked in 10-block ranges.
 * Fifty ranges cover 500 blocks for one extra sleep per range.
 */
const LOG_WINDOW_BLOCKS = 500n;
const LOG_RANGE_BLOCKS = 10n;

/** Cap on recipients carried into the batched reads. */
const MAX_RECIPIENTS = 50;

/** A second between aggregator requests. Nothing here is in a hurry. */
const AGGREGATOR_DELAY_MS = 1_000;

/**
 * The control sender: a well-formed address assembled from one repeated
 * byte. It holds no key, no stock and no approval, so the same call from it
 * must revert.
 */
const STRANGER = getAddress(`0x${"cd".repeat(20)}`);

/** `Transfer(address,address,uint256)`, as a fragment — the topic is derived. */
const TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/** `balanceOf(address)`, as a fragment. */
const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** `allowance(address,address)`, as a fragment. */
const ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Multicall3 `aggregate`, as a fragment — one `eth_call` for a whole batch
 * of view reads, so the recipient scan costs two requests instead of dozens
 * against a rate-limited endpoint. The address is the verified genesis
 * preinstall from `lib/rpc`, not a discovery.
 */
const MULTICALL_ABI = [
  {
    type: "function",
    name: "aggregate",
    stateMutability: "view",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "blockNumber", type: "uint256" },
      { name: "returnData", type: "bytes[]" },
    ],
  },
] as const;

const NVDA_ADDRESS = TOKEN_ADDRESSES.NVDA;
const NVDA_DECIMALS = TOKEN_DECIMALS.NVDA;

type TransferLog = {
  topics: string[];
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One raw JSON-RPC request. Throws with the endpoint's own message on error. */
async function rpc(
  url: string,
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text !== "") {
        try {
          const failed = JSON.parse(text) as {
            error?: { code?: unknown; message?: string };
          };
          detail += `: ${failed.error?.message ?? text.slice(0, 300)}`;
        } catch {
          detail += `: ${text.slice(0, 300)}`;
        }
      }
    } catch {
      // The status above is the report when the body cannot be read.
    }
    throw new Error(`${method} failed: ${detail} from ${hostOf(url)}`);
  }

  const body = (await response.json()) as {
    result?: unknown;
    error?: { code?: unknown; message?: string; data?: unknown };
  };

  if (body.error !== undefined) {
    const detail = body.error.message ?? JSON.stringify(body.error);
    throw new Error(`${method} failed: ${detail}`);
  }

  return body.result;
}

/** The endpoint's host, for logs — never the full URL, which may carry a key. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured endpoint";
  }
}

function hexToBigInt(value: unknown): bigint {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`expected hex, got ${String(value)}`);
  }
  if (value === "0x") return 0n;
  return BigInt(value);
}

async function ethBlockNumber(url: string): Promise<bigint> {
  await sleep(READ_DELAY_MS);
  return hexToBigInt(await rpc(url, "eth_blockNumber", []));
}

async function ethGetLogsRange(
  url: string,
  address: string,
  topic0: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TransferLog[]> {
  await sleep(READ_DELAY_MS);
  const result = (await rpc(url, "eth_getLogs", [
    {
      address,
      topics: [topic0],
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    },
  ])) as TransferLog[];

  if (!Array.isArray(result)) throw new Error("eth_getLogs returned no array");
  return result;
}

async function ethCallTx(
  url: string,
  tx: Record<string, unknown>,
): Promise<Hex> {
  await sleep(READ_DELAY_MS);
  const result = await rpc(url, "eth_call", [tx, "latest"]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`eth_call returned ${String(result)}`);
  }
  return result as Hex;
}

/**
 * One batched view read per recipient: `balanceOf` or
 * `allowance(recipient, router)` down the same `recipients` order.
 *
 * `balanceOf` and `allowance` never revert for a well-formed address, so
 * `aggregate` — which reverts the batch if any leg reverts — is safe here,
 * and every recipient below came out of a log topic via `getAddress`.
 */
async function batchReadUint(
  url: string,
  recipients: string[],
  kind: "balance" | "allowance",
): Promise<bigint[]> {
  const calls = recipients.map((recipient) => ({
    target: NVDA_ADDRESS as Hex,
    callData: encodeFunctionData({
      abi: kind === "balance" ? BALANCE_OF_ABI : ALLOWANCE_ABI,
      functionName: kind === "balance" ? "balanceOf" : "allowance",
      args:
        kind === "balance"
          ? ([recipient as Hex] as const)
          : ([recipient as Hex, KYBERSWAP_ROUTER_ADDRESS as Hex] as const),
    }),
  }));

  const data = encodeFunctionData({
    abi: MULTICALL_ABI,
    functionName: "aggregate",
    args: [calls],
  });

  await sleep(READ_DELAY_MS);
  const result = await rpc(url, "eth_call", [
    { to: MULTICALL3_ADDRESS, data },
    "latest",
  ]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`multicall returned ${String(result)}`);
  }

  const [, returnDatas] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes[]" }] as const,
    result as Hex,
  );

  return returnDatas.map((raw) => {
    const [value] = decodeAbiParameters([{ type: "uint256" }] as const, raw);
    return value;
  });
}

/** The `to` of a Transfer log: the last 20 bytes of the third topic. */
function logRecipient(log: TransferLog): string | null {
  const topic = log.topics[2];
  if (typeof topic !== "string" || !topic.startsWith("0x") || topic.length !== 66) {
    return null;
  }
  try {
    return getAddress(`0x${topic.slice(-40)}`);
  } catch {
    return null;
  }
}

describe("the pinned router, executed for a sale against live Base state", () => {
  it("simulates 0.01 NVDA into USDC with no funds and no signature", async () => {
    const dedicated = dedicatedRpcUrl();
    if (dedicated === null) {
      throw new Error(
        "BASE_RPC_URL is not set. This script reads live allowances in bulk, " +
          "which public Base endpoints rate-limit after roughly a dozen calls — " +
          "so it runs exclusively through the dedicated endpoint. Set BASE_RPC_URL and retry.",
      );
    }
    const url = dedicated;
    console.info(`  rpc ${hostOf(url)} (from BASE_RPC_URL)`);

    // --- Step 1: a real approver, found mechanically. ---
    const transferTopics = encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer" });
    const transferTopic0 = transferTopics[0];
    if (typeof transferTopic0 !== "string") {
      throw new Error("encodeEventTopics returned no Transfer topic");
    }
    console.info(`  Transfer topic ${transferTopic0} (derived, not literal)`);

    const latest = await ethBlockNumber(url);
    const fromBlock = latest - LOG_WINDOW_BLOCKS > 0n ? latest - LOG_WINDOW_BLOCKS : 0n;
    console.info(`  scanning NVDA Transfers over blocks ${fromBlock}..${latest} in ${LOG_RANGE_BLOCKS}-block ranges`);

    const logs: TransferLog[] = [];
    for (let start = fromBlock; start <= latest; start += LOG_RANGE_BLOCKS) {
      const end = start + LOG_RANGE_BLOCKS - 1n > latest ? latest : start + LOG_RANGE_BLOCKS - 1n;
      logs.push(...(await ethGetLogsRange(url, NVDA_ADDRESS, transferTopic0, start, end)));
    }
    console.info(`  ${logs.length} Transfer logs in range`);
    expect(logs.length, "no NVDA Transfers in range: widen the window").toBeGreaterThan(0);

    // Newest-first, deduplicated, bounded — the batch reads below are one
    // request per kind however many recipients there are.
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (let index = logs.length - 1; index >= 0; index -= 1) {
      const log = logs[index];
      if (log === undefined) continue;
      const candidate = logRecipient(log);
      if (candidate === null || seen.has(candidate)) continue;
      seen.add(candidate);
      recipients.push(candidate);
      if (recipients.length >= MAX_RECIPIENTS) break;
    }
    console.info(`  ${recipients.length} unique recipients to check`);

    const balances = await batchReadUint(url, recipients, "balance");
    const allowances = await batchReadUint(url, recipients, "allowance");

    // The simulation spends exactly SIM_TOKEN_UNITS, so both the stock and
    // the approval must cover it — a funded holder with a spent approval
    // proves nothing.
    let holder: string | null = null;
    let holderBalance = 0n;
    let holderAllowance = 0n;
    for (let index = 0; index < recipients.length; index += 1) {
      const candidate = recipients[index];
      const balance = balances[index];
      const allowance = allowances[index];
      if (candidate === undefined || balance === undefined || allowance === undefined) {
        continue;
      }
      if (balance >= SIM_TOKEN_UNITS && allowance >= SIM_TOKEN_UNITS) {
        holder = candidate;
        holderBalance = balance;
        holderAllowance = allowance;
        break;
      }
    }

    expect(
      holder,
      `no NVDA holder with ${SIM_TOKEN_UNITS} units and matching router approval among ${recipients.length} recent recipients: ` +
        "without a live approval the sale cannot be executed against real state, and this " +
        "script stops here rather than pretending. The sale still needs a live proof before it ships.",
    ).not.toBeNull();
    if (holder === null) return;
    console.info(
      `  holder ${holder} holds ${holderBalance} units (${Number(holderBalance) / 10 ** NVDA_DECIMALS} shares) ` +
        `with ${holderAllowance} approved to the router (both read live)`,
    );

    // --- Step 2: a fresh sale route, built for that sender. ---
    await sleep(AGGREGATOR_DELAY_MS);
    const { result, routeSummary } = await requestSellRoute("NVDA", SIM_TOKEN_UNITS);

    if (result.kind === "no-liquidity") {
      console.info(`  no sale route today: ${result.detail}`);
      return;
    }

    expect(result.kind, result.kind === "quote" ? "" : result.detail).toBe("quote");
    if (result.kind !== "quote") return;
    expect(routeSummary, "a priced sale route with no routeSummary: nothing to build from").not.toBeNull();
    if (routeSummary === null) return;

    const { quote } = result;
    const floor = minAmountOutFor(quote.usdcOut, SLIPPAGE_BPS);
    if (floor === null) {
      throw new Error(`${quote.usdcOut} USDC units has no floor at ${SLIPPAGE_BPS}bps`);
    }
    console.info(
      `  quoted ${quote.usdOut.toFixed(4)} USDC for ${quote.sharesIn} shares, floor ${floor} at ${SLIPPAGE_BPS}bps`,
    );

    await sleep(AGGREGATOR_DELAY_MS);
    const built = await buildSellSwap({
      quote,
      routeSummary,
      sender: holder,
      minAmountOut: floor,
    });

    expect(built.kind, built.kind === "transaction" ? "" : built.detail).toBe("transaction");
    if (built.kind !== "transaction") return;

    const tx = built.transaction;
    console.info(`  to            ${tx.to}`);
    console.info(`  value         ${tx.value}`);
    console.info(`  amountIn      ${tx.amountIn} token units`);
    console.info(`  amountOut     ${tx.amountOut} USDC units`);
    console.info(`  minAmountOut  ${tx.minAmountOut} (ours, at ${tx.slippageBps}bps)`);

    // The pin, not the echo — same assertions as every other verify script.
    expect(tx.to, "to is not the pinned router").toBe(KYBERSWAP_ROUTER_ADDRESS);
    expect(tx.value, "a sale that would send ETH").toBe("0");

    // --- Step 3: the same eth_call twice — approver, then stranger. ---
    //
    // No overrides anywhere: the holder's own balance and approval do the
    // work, on live state. The stranger holds nothing and has approved
    // nothing, so the identical call from it must revert — the pair is what
    // proves the first call executed a swap rather than passing vacuously.
    const fundedCall = { from: holder, to: tx.to, data: tx.data, value: "0x0" };
    const returnData = await ethCallTx(url, fundedCall);

    console.info(`  simulation returned ${returnData}`);
    // The router's return shape is not verifiable from its ABI: no router
    // ABI is pinned anywhere in the repo, and decoding the bytes would mean
    // assuming an encoding the response never stated. The assertion stops at
    // non-empty — success plus data, which is what separates an executed
    // sale from a call that merely did not revert.
    expect(returnData, "simulation from the approver returned no data").toMatch(
      /^0x([0-9a-fA-F]{2})+$/,
    );

    let reverted = false;
    let revertDetail = "";
    try {
      const vacuous = await ethCallTx(url, {
        from: STRANGER,
        to: tx.to,
        data: tx.data,
        value: "0x0",
      });
      console.info(`  from the stranger unexpectedly succeeded: ${vacuous}`);
    } catch (cause) {
      reverted = true;
      revertDetail = describeError(cause);
      console.info(`  from the stranger reverted as expected: ${revertDetail}`);
    }

    expect(reverted, "simulation without funds succeeded: the success above proves nothing").toBe(true);
    expect(
      revertDetail.toLowerCase(),
      `the unfunded call failed without a revert (${revertDetail}): expected an execution revert, not a transport error`,
    ).toMatch(/revert/);
  });
});
