import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import { describe, expect, it } from "vitest";

import { SLIPPAGE_BPS, minAmountOutFor } from "@/lib/build";
import { KYBERSWAP_ROUTER_ADDRESS } from "@/lib/quote";
import { READ_DELAY_MS, dedicatedRpcUrl, sleep } from "@/lib/rpc";
import {
  buildSellSwap,
  requestSellRoute,
} from "@/lib/sell";
import { TOKEN_ADDRESSES, TOKEN_DECIMALS } from "@/lib/tokens";

/**
 * The pinned router, executed for a SALE against live Base state — with no
 * funds, no wallet and no signature.
 *
 * The mirror of `verify/simulate.verify.ts`: a fresh NVDA→USDC route is
 * built for a synthetic sender, then `eth_call`ed with a `stateDiff` on the
 * stock token giving that sender a sufficient stock balance and a sufficient
 * stock approval to the pinned router. The same call without overrides must
 * revert. The pair proves the overrides caused the success.
 *
 * NO FUNDS, NO WALLET, NO SIGNATURE. Same arrangement as the buy
 * simulation: the sender is assembled from one repeated byte, and its
 * balance and approval exist only inside `eth_call` state overrides.
 *
 * ONE OPEN QUESTION THIS SCRIPT SETTLES. The stock tokens are B20
 * precompiles with one byte of code, and a precompile's balances may live in
 * native client state rather than in contract storage that `eth_getStorageAt`
 * and `stateDiff` can see. Step 2 therefore starts by asking: the balances
 * slot is whichever of slots 0..20 reads back the holder's `balanceOf`. If
 * none of them does while `balanceOf` is positive, precompile storage is not
 * exposed that way, and the script fails loudly saying exactly that — it
 * does not pretend a simulation ran. That verdict is itself the finding.
 *
 * Like the buy script this runs exclusively through `BASE_RPC_URL`: public
 * endpoints generally reject state overrides, and a rejection fails naming
 * the endpoint as the likely cause rather than reporting a failed sale.
 */

type Hex = `0x${string}`;

/** 0.01 NVDA shares, in token base units. Well inside the sell band. */
const SIM_TOKEN_UNITS = 1_000_000n;

/** Single-block newest-first walk bound, for the holder search. */
const HOLDER_SEARCH_BLOCKS = 30n;

/** A second between aggregator requests. Nothing here is in a hurry. */
const AGGREGATOR_DELAY_MS = 1_000;

/**
 * A placeholder sender: a well-formed address assembled from one repeated
 * byte. Not transcribed from anywhere and not an account.
 */
const SENDER = getAddress(`0x${"cd".repeat(20)}`);

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

/** A distinctive nonzero sentinel for the allowance write-and-read-back. */
const ALLOWANCE_SENTINEL = 123_456_789n;

const NVDA_ADDRESS = TOKEN_ADDRESSES.NVDA;
const NVDA_DECIMALS = TOKEN_DECIMALS.NVDA;

type TransferLog = {
  topics: string[];
  transactionHash?: string;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One raw JSON-RPC request. On a non-OK status the JSON-RPC error body is
 * kept — a 400 from Alchemy carries the specific reason, and discarding it
 * hides exactly what is needed to tell an over-wide range apart from an
 * unsupported override.
 */
async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
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

async function ethGetLogs(
  url: string,
  address: string,
  topic0: string,
  block: bigint,
): Promise<TransferLog[]> {
  await sleep(READ_DELAY_MS);
  const hexBlock = `0x${block.toString(16)}`;
  const result = (await rpc(url, "eth_getLogs", [
    { address, topics: [topic0], fromBlock: hexBlock, toBlock: hexBlock },
  ])) as TransferLog[];

  if (!Array.isArray(result)) throw new Error("eth_getLogs returned no array");
  return result;
}

async function ethGetStorageAt(
  url: string,
  address: string,
  position: Hex,
  block: string = "latest",
): Promise<Hex> {
  await sleep(READ_DELAY_MS);
  const result = await rpc(url, "eth_getStorageAt", [address, position, block]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`eth_getStorageAt returned ${String(result)}`);
  }
  return result as Hex;
}

async function ethCallTx(url: string, tx: Record<string, unknown>): Promise<Hex> {
  await sleep(READ_DELAY_MS);
  const result = await rpc(url, "eth_call", [tx, "latest"]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`eth_call returned ${String(result)}`);
  }
  return result as Hex;
}

async function ethCallWithOverride(
  url: string,
  tx: Record<string, unknown>,
  override: Record<string, unknown>,
): Promise<Hex> {
  await sleep(READ_DELAY_MS);
  const result = await rpc(url, "eth_call", [tx, "latest", override]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`eth_call returned ${String(result)}`);
  }
  return result as Hex;
}

async function ethCallView(
  url: string,
  to: string,
  data: Hex,
  block: string = "latest",
): Promise<bigint> {
  await sleep(READ_DELAY_MS);
  const result = await rpc(url, "eth_call", [{ to, data }, block]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`eth_call returned ${String(result)}`);
  }
  return hexToBigInt(result);
}

function overrideRejected(url: string, cause: unknown): Error {
  return new Error(
    `eth_call with state overrides was rejected by ${hostOf(url)} (${describeError(cause)}). ` +
      "This usually means the RPC endpoint does not support state overrides — public Base " +
      "endpoints generally do not. Set BASE_RPC_URL to a dedicated node that does and retry. " +
      "This is an endpoint limitation, not a failed sale.",
  );
}

/** `keccak256(abi.encode(holder, slot))` — the balances mapping location. */
function balanceKeyFor(holder: string, slot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder as Hex, slot],
    ),
  );
}

/**
 * `keccak256(abi.encode(spender, keccak256(abi.encode(owner, slot))))` —
 * the nested allowance mapping location.
 */
function allowanceKeyFor(owner: string, spender: string, slot: bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [owner as Hex, slot],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [spender as Hex, inner],
    ),
  );
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
        "BASE_RPC_URL is not set. This script proves the sale with eth_call state overrides, " +
          "which public Base endpoints generally reject — so it runs exclusively through the " +
          "dedicated endpoint. Set BASE_RPC_URL to a node that supports overrides and retry.",
      );
    }
    const url = dedicated;
    console.info(`  rpc ${hostOf(url)} (from BASE_RPC_URL)`);

    // --- Step 1: a funded NVDA holder, found mechanically. ---
    const transferTopics = encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer" });
    const transferTopic0 = transferTopics[0];
    if (typeof transferTopic0 !== "string") {
      throw new Error("encodeEventTopics returned no Transfer topic");
    }
    console.info(`  Transfer topic ${transferTopic0} (derived, not literal)`);

    const latest = await ethBlockNumber(url);
    // Pinned for steps 1–2: the holder is hot by construction, so its
    // balance can move between two `latest` reads. Every balanceOf and
    // eth_getStorageAt below reads at this one block.
    const pinnedHex = `0x${latest.toString(16)}`;
    console.info(`  scanning NVDA Transfers newest-first from block ${latest}`);

    let holder: string | null = null;
    let holderBalance = 0n;
    let holderBlock = 0n;
    for (let back = 0n; back < HOLDER_SEARCH_BLOCKS; back += 1n) {
      const block = latest - back;
      if (block < 0n) break;

      const logs = await ethGetLogs(url, NVDA_ADDRESS, transferTopic0, block);
      if (logs.length === 0) continue;

      for (let index = logs.length - 1; index >= 0; index -= 1) {
        const log = logs[index];
        if (log === undefined) continue;
        const candidate = logRecipient(log);
        if (candidate === null) continue;

        const data = encodeFunctionData({
          abi: BALANCE_OF_ABI,
          functionName: "balanceOf",
          args: [candidate as Hex],
        });
        const balance = await ethCallView(url, NVDA_ADDRESS, data, pinnedHex);
        if (balance > 0n) {
          holder = candidate;
          holderBalance = balance;
          holderBlock = block;
          break;
        }
      }

      if (holder !== null) break;
    }

    expect(holder, `no funded NVDA holder in the ${HOLDER_SEARCH_BLOCKS} blocks back from ${latest}`).not.toBeNull();
    if (holder === null) return;
    console.info(
      `  holder ${holder} from block ${holderBlock} holds ${holderBalance} token units (${Number(holderBalance) / 10 ** NVDA_DECIMALS} shares, confirmed by balanceOf)`,
    );

    // --- Step 2a: the token's balances slot, by proof — or an honest no. ---
    const balanceMatches: number[] = [];
    for (let slot = 0; slot <= 20; slot += 1) {
      const position = balanceKeyFor(holder, BigInt(slot));
      const stored = await ethGetStorageAt(url, NVDA_ADDRESS, position, pinnedHex);
      if (hexToBigInt(stored) === holderBalance) balanceMatches.push(slot);
    }

    // The buy script proved USDC's storage is ordinary. A B20 precompile may
    // keep balances in native client state that neither eth_getStorageAt nor
    // stateDiff can see — in which case zero matches alongside a positive
    // balanceOf is the finding, and everything below would be theatre.
    expect(
      balanceMatches.length > 0,
      `no balances slot among 0..20 reads back ${holderBalance} while balanceOf does: ` +
        "this B20 precompile keeps balances outside contract storage, so a stateDiff " +
        "simulation cannot fund a sender and this script stops here rather than " +
        "pretending. The sale still needs a live proof before it ships.",
    ).toBe(true);
    expect(
      balanceMatches,
      `balances slot search matched ${balanceMatches.length} of slots 0..20, expected exactly one`,
    ).toHaveLength(1);
    const balancesSlot = balanceMatches[0];
    if (balancesSlot === undefined) return;
    console.info(`  NVDA balances mapping is at slot index ${balancesSlot}`);

    // --- Step 2b: the allowance slot, by write-and-read-back. ---
    const allowanceData = encodeFunctionData({
      abi: ALLOWANCE_ABI,
      functionName: "allowance",
      args: [SENDER, KYBERSWAP_ROUTER_ADDRESS as Hex],
    });
    const allowanceMatches: number[] = [];
    for (let slot = 0; slot <= 20; slot += 1) {
      const position = allowanceKeyFor(SENDER, KYBERSWAP_ROUTER_ADDRESS, BigInt(slot));
      let readBack: bigint;
      try {
        const result = await ethCallWithOverride(
          url,
          { to: NVDA_ADDRESS, data: allowanceData },
          { [NVDA_ADDRESS]: { stateDiff: { [position]: toHex(ALLOWANCE_SENTINEL, { size: 32 }) } } },
        );
        readBack = hexToBigInt(result);
      } catch (cause) {
        throw overrideRejected(url, cause);
      }
      if (readBack === ALLOWANCE_SENTINEL) allowanceMatches.push(slot);
    }

    expect(
      allowanceMatches,
      `allowance slot search matched ${allowanceMatches.length} of slots 0..20, expected exactly one`,
    ).toHaveLength(1);
    const allowanceSlot = allowanceMatches[0];
    if (allowanceSlot === undefined) return;
    console.info(`  NVDA allowance mapping is at slot index ${allowanceSlot}`);

    // --- Step 3: a fresh sale route, built for the synthetic sender. ---
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
      sender: SENDER,
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

    // --- Step 4: the same eth_call twice — with overrides, then without. ---
    //
    // USDC storage only on the buy side; here, token storage only — never
    // the token's code, because pools verify payment by balance delta and a
    // stubbed token makes every pool revert.
    const funded = tx.amountIn * 2n;
    const balancePosition = balanceKeyFor(SENDER, BigInt(balancesSlot));
    const allowancePosition = allowanceKeyFor(SENDER, KYBERSWAP_ROUTER_ADDRESS, BigInt(allowanceSlot));
    const stateOverride = {
      [NVDA_ADDRESS]: {
        stateDiff: {
          [balancePosition]: toHex(funded, { size: 32 }),
          [allowancePosition]: toHex(funded, { size: 32 }),
        },
      },
    };
    const callTx = { from: SENDER, to: tx.to, data: tx.data, value: "0x0" };

    let returnData: Hex;
    try {
      returnData = await ethCallWithOverride(url, callTx, stateOverride);
    } catch (cause) {
      throw overrideRejected(url, cause);
    }

    console.info(`  simulation returned ${returnData}`);
    // The router's return shape is not verifiable from its ABI: no router
    // ABI is pinned anywhere in the repo, and decoding the bytes would mean
    // assuming an encoding the response never stated. The assertion stops at
    // non-empty — success plus data, which is what separates an executed
    // sale from a call that merely did not revert.
    expect(returnData, "simulation with funds returned no data").toMatch(/^0x([0-9a-fA-F]{2})+$/);

    let reverted = false;
    let revertDetail = "";
    try {
      const vacuous = await ethCallTx(url, callTx);
      console.info(`  without overrides unexpectedly succeeded: ${vacuous}`);
    } catch (cause) {
      reverted = true;
      revertDetail = describeError(cause);
      console.info(`  without overrides reverted as expected: ${revertDetail}`);
    }

    expect(reverted, "simulation without funds succeeded: the success above proves nothing").toBe(true);
    expect(
      revertDetail.toLowerCase(),
      `the unfunded call failed without a revert (${revertDetail}): expected an execution revert, not a transport error`,
    ).toMatch(/revert/);
  });
});
