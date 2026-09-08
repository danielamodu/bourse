import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  SLIPPAGE_BPS,
  buildSwap,
  minAmountOutFor,
  requestRoute,
} from "@/lib/build";
import { KYBERSWAP_ROUTER_ADDRESS } from "@/lib/quote";
import { READ_DELAY_MS, dedicatedRpcUrl, sleep } from "@/lib/rpc";
import { USDC_ADDRESS } from "@/lib/tokens";

/**
 * The pinned router, executed for real against live Base state — with no
 * funds, no wallet and no signature.
 *
 * Not part of `npm test`. Live network and a live aggregator, so it sits
 * behind `npm run verify:simulate` and is run deliberately, before any USDC
 * allowance is ever granted. What it proves is that the calldata the build
 * path hands a wallet actually executes a swap when the sender holds USDC
 * and has approved the pinned router — and that it reverts when they do not.
 *
 * NO FUNDS, NO WALLET, NO SIGNATURE. The sender below is a well-formed
 * address assembled from one repeated byte: it holds no key, no ETH and no
 * USDC. Its balance and its approval exist only inside `eth_call` state
 * overrides applied to USDC storage, which vanish when the call returns.
 * Nothing is signed, so nothing can be submitted.
 *
 * Four steps, each one self-verifying so nothing rests on a number supplied
 * here:
 *
 * 1. A funded USDC holder is found mechanically, from `eth_getLogs` over the
 *    last ~50 blocks filtered on USDC and the Transfer topic. The topic is
 *    derived with `encodeEventTopics` from an ABI fragment, never a literal
 *    hash, and the holder is confirmed with `balanceOf` before use. No
 *    address is hardcoded and none is supplied.
 * 2. USDC's storage slots are discovered by proof. For candidate indices 0
 *    through 20, `keccak256(abi.encode(holder, slot))` is read with
 *    `eth_getStorageAt`; the balances slot is whichever candidate's stored
 *    value equals the holder's `balanceOf` return. The nested allowance
 *    mapping is proven the same way, by writing a sentinel through a
 *    `stateDiff` and confirming `allowance()` reads it back under override
 *    (there is no nonzero approval pair at hand to compare against without
 *    indexing approvals, so the write-and-read-back is the proof). Either
 *    search fails loudly on zero or multiple matches. Both indices print.
 * 3. A fresh $2 NVDA route is built for the synthetic sender, and its
 *    `{ to, data, value }` is `eth_call`ed with a `stateDiff` on USDC giving
 *    that sender a sufficient balance and a sufficient allowance to the
 *    pinned router. USDC storage only — never its code, because pools verify
 *    payment by balance delta and a stubbed token makes every pool revert.
 * 4. The same `eth_call` runs twice: with overrides it must succeed and
 *    return non-empty data; without them it must revert. The pair is what
 *    proves the overrides caused the success rather than the simulation
 *    passing vacuously. Both directions are asserted.
 *
 * State overrides need a node that supports them — public Base endpoints
 * generally do not — so this script also proves `BASE_RPC_URL` is being
 * used: it runs exclusively through the dedicated endpoint and fails with a
 * message naming that as the likely cause when an override is rejected,
 * rather than reporting it as a failed swap.
 */

type Hex = `0x${string}`;

/** $2 of NVDA, in USDC base units. Inside the quote band ($1–$1M). */
const SIM_USDC_UNITS = 2_000_000n;

/**
 * How far back the holder search is willing to walk, one block at a time.
 *
 * USDC is the highest-traffic contract on Base, so a 50-block eth_getLogs
 * range exceeds Alchemy's result cap. A single block essentially always
 * carries Transfers, and the first funded recipient found newest-first ends
 * the search — the bound below is a backstop, not the expected path.
 */
const HOLDER_SEARCH_BLOCKS = 30n;

/** A second between aggregator requests. Nothing here is in a hurry. */
const AGGREGATOR_DELAY_MS = 1_000;

/**
 * A placeholder sender: a well-formed address assembled from one repeated
 * byte. Same convention as `verify/build.verify.ts`.
 *
 * Not transcribed from anywhere and not an account — no address literal
 * enters the repo for a script's convenience. The build endpoint needs a
 * sender to encode a `recipient` against, and the simulation needs a `from`
 * whose USDC balance and approval exist only as overrides.
 */
const SENDER = getAddress(`0x${"ab".repeat(20)}`);

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

type TransferLog = {
  topics: string[];
  transactionHash?: string;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One raw JSON-RPC request. Throws on transport failure or on a JSON-RPC
 * error, with the method and the endpoint's own message in the error — the
 * simulation's revert assertion depends on telling those apart from success.
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
    // A 400 from Alchemy carries the specific reason in the JSON-RPC error
    // body. Discarding it and reporting only the HTTP status hides exactly
    // what is needed to tell an over-wide eth_getLogs range apart from an
    // unsupported override, so the body is read and its message kept.
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
      // The status above is the report when the body itself cannot be read.
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

/** One `eth_call` without overrides — the plain two-parameter form. */
async function ethCallTx(
  url: string,
  tx: Record<string, unknown>,
  block: string = "latest",
): Promise<Hex> {
  await sleep(READ_DELAY_MS);
  const result = await rpc(url, "eth_call", [tx, block]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`eth_call returned ${String(result)}`);
  }
  return result as Hex;
}

/**
 * One `eth_call` with a state override — the three-parameter form.
 *
 * Throws the endpoint's own rejection upward. Callers wrap it with
 * {@link overrideRejected} so a node that does not support overrides fails
 * with that named as the likely cause rather than as a failed swap.
 */
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

/** A view call with no `from`: `balanceOf` and `allowance` need none. */
async function ethCallView(
  url: string,
  to: string,
  data: Hex,
  block: string = "latest",
): Promise<bigint> {
  const result = await ethCallTx(url, { to, data }, block);
  return hexToBigInt(result);
}

/** Names the endpoint limitation when an override is rejected. */
function overrideRejected(url: string, cause: unknown): Error {
  return new Error(
    `eth_call with state overrides was rejected by ${hostOf(url)} (${describeError(cause)}). ` +
      "This usually means the RPC endpoint does not support state overrides — public Base " +
      "endpoints generally do not. Set BASE_RPC_URL to a dedicated node that does and retry. " +
      "This is an endpoint limitation, not a failed swap.",
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

describe("the pinned router, executed against live Base state", () => {
  it(`simulates $${Number(SIM_USDC_UNITS) / 1_000_000} of NVDA with no funds and no signature`, async () => {
    const dedicated = dedicatedRpcUrl();
    if (dedicated === null) {
      throw new Error(
        "BASE_RPC_URL is not set. This script proves the swap with eth_call state overrides, " +
          "which public Base endpoints generally reject — so it runs exclusively through the " +
          "dedicated endpoint. Set BASE_RPC_URL to a node that supports overrides and retry.",
      );
    }
    const url = dedicated;
    console.info(`  rpc ${hostOf(url)} (from BASE_RPC_URL)`);

    // --- Step 1: a funded USDC holder, found mechanically. ---
    const transferTopics = encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer" });
    const transferTopic0 = transferTopics[0];
    if (typeof transferTopic0 !== "string") {
      throw new Error("encodeEventTopics returned no Transfer topic");
    }
    console.info(`  Transfer topic ${transferTopic0} (derived, not literal)`);

    // Newest-first, one block at a time: a multi-block USDC Transfer range
    // exceeds Alchemy's eth_getLogs result cap, while a single block stays
    // far under it. The first `to` whose balanceOf confirms funds ends the
    // search; empty blocks just walk further back within the bound.
    const latest = await ethBlockNumber(url);
    // Pinned for steps 1–2a: the holder is the most active address on Base by
    // construction, so its balance can move between two `latest` reads and a
    // floating comparison would miss the slot. Every balanceOf and
    // eth_getStorageAt below reads at this one block, where the two must agree.
    const pinnedHex = `0x${latest.toString(16)}`;
    console.info(`  scanning USDC Transfers newest-first from block ${latest} (reads pinned at ${pinnedHex})`);

    let holder: string | null = null;
    let holderBalance = 0n;
    let holderBlock = 0n;
    for (let back = 0n; back < HOLDER_SEARCH_BLOCKS; back += 1n) {
      const block = latest - back;
      if (block < 0n) break;

      const logs = await ethGetLogs(url, USDC_ADDRESS, transferTopic0, block, block);
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
        const balance = await ethCallView(url, USDC_ADDRESS, data, pinnedHex);
        if (balance > 0n) {
          holder = candidate;
          holderBalance = balance;
          holderBlock = block;
          break;
        }
      }

      if (holder !== null) break;
    }

    expect(holder, `no funded USDC holder in the ${HOLDER_SEARCH_BLOCKS} blocks back from ${latest}`).not.toBeNull();
    if (holder === null) return;
    console.info(
      `  holder ${holder} from block ${holderBlock} holds ${holderBalance} USDC units (confirmed by balanceOf)`,
    );

    // --- Step 2a: USDC's balances slot, by proof. ---
    const balanceMatches: number[] = [];
    for (let slot = 0; slot <= 20; slot += 1) {
      const position = balanceKeyFor(holder, BigInt(slot));
      const stored = await ethGetStorageAt(url, USDC_ADDRESS, position, pinnedHex);
      if (hexToBigInt(stored) === holderBalance) balanceMatches.push(slot);
    }

    expect(
      balanceMatches,
      `balances slot search matched ${balanceMatches.length} of slots 0..20, expected exactly one`,
    ).toHaveLength(1);
    const balancesSlot = balanceMatches[0];
    if (balancesSlot === undefined) return;
    console.info(`  USDC balances mapping is at slot index ${balancesSlot}`);

    // --- Step 2b: USDC's allowance slot, by write-and-read-back. ---
    //
    // No nonzero (owner, spender) approval pair is at hand to compare storage
    // against without indexing approvals, so the proof is a write: store the
    // sentinel through a stateDiff at each candidate's nested location and see
    // which candidate makes allowance(SENDER, router) read it back. The owner
    // is the same synthetic sender the simulation funds below, so the
    // discovery validates exactly the pair the simulation overrides.
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
          { to: USDC_ADDRESS, data: allowanceData },
          { [USDC_ADDRESS]: { stateDiff: { [position]: toHex(ALLOWANCE_SENTINEL, { size: 32 }) } } },
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
    console.info(`  USDC allowance mapping is at slot index ${allowanceSlot}`);

    // --- Step 3: a fresh route, built for the synthetic sender. ---
    await sleep(AGGREGATOR_DELAY_MS);
    const { result, routeSummary } = await requestRoute("NVDA", SIM_USDC_UNITS);

    if (result.kind === "no-liquidity") {
      // Depth follows weekly Aerodrome gauge votes. No route for $2 of NVDA
      // today is news about Base rather than a broken simulation, and
      // `verify:quote` is where a missing route is judged.
      console.info(`  no route today: ${result.detail}`);
      return;
    }

    expect(result.kind, result.kind === "quote" ? "" : result.detail).toBe("quote");
    if (result.kind !== "quote") return;
    expect(routeSummary, "a priced route with no routeSummary: nothing to build from").not.toBeNull();
    if (routeSummary === null) return;

    const { quote } = result;
    const floor = minAmountOutFor(quote.unitsOut, SLIPPAGE_BPS);
    if (floor === null) {
      throw new Error(`${quote.unitsOut} units has no floor at ${SLIPPAGE_BPS}bps`);
    }
    console.info(
      `  quoted ${quote.shares} shares (${quote.unitsOut} units), floor ${floor} at ${SLIPPAGE_BPS}bps`,
    );

    await sleep(AGGREGATOR_DELAY_MS);
    const built = await buildSwap({
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
    console.info(`  amountIn      ${tx.amountIn} USDC units`);
    console.info(`  amountOut     ${tx.amountOut} token units`);
    console.info(`  minAmountOut  ${tx.minAmountOut} (ours, at ${tx.slippageBps}bps)`);

    // The pin, not the echo — same assertions as the other verify scripts.
    expect(tx.to, "to is not the pinned router").toBe(KYBERSWAP_ROUTER_ADDRESS);
    expect(tx.value, "a swap that would send ETH").toBe("0");

    // --- Step 4: the same eth_call twice — with overrides, then without. ---
    //
    // The override touches USDC storage only: a balance and an approval for
    // the synthetic sender. Its code is never overridden, because pools
    // verify payment by balance delta and a stubbed token makes every pool
    // revert. The sender is funded comfortably above amountIn so the call
    // cannot fail for lack of funds.
    const funded = tx.amountIn * 2n;
    const balancePosition = balanceKeyFor(SENDER, BigInt(balancesSlot));
    const allowancePosition = allowanceKeyFor(SENDER, KYBERSWAP_ROUTER_ADDRESS, BigInt(allowanceSlot));
    const stateOverride = {
      [USDC_ADDRESS]: {
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
    // assuming an encoding the response never stated. So the assertion stops
    // at non-empty — success plus data, which is what separates an executed
    // swap from a call that merely did not revert.
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
