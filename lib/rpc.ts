import { createPublicClient, fallback, http, type Chain } from "viem";

/**
 * Base read plumbing.
 *
 * `mainnet.base.org` starts returning `over rate limit` after roughly a dozen
 * `eth_call`s in quick succession, and the markets grid needs a feed read and a
 * `decimals()` per token — 26 calls if issued naively. Two defences:
 *
 * 1. Batch. Every grid read goes through Multicall3 as a single `eth_call`, so
 *    26 reads cost one request. `lib/read-prices.ts` does this.
 * 2. Rotate. Requests start from a different public endpoint each time and fall
 *    through to the others on failure, so no single endpoint carries the load.
 *
 * Anything that genuinely cannot be batched — hand-verifying four addresses, for
 * instance — uses `ethCall` one at a time with `sleep` in between.
 *
 * The chain is declared here rather than imported from `viem/chains`. That entry
 * point is a barrel of every chain viem ships, and pulling it in to read one
 * number and one address drags the rest along — including `tempo`, whose `ox`
 * dependency makes webpack emit "Critical dependency: the request of a
 * dependency is an expression". Four fields is all a read client uses.
 */

/** Base mainnet. */
export const BASE_CHAIN_ID = 8453;

/**
 * Multicall3, at the address it is deployed to on Base.
 *
 * Copied from `node_modules/viem/_esm/chains/definitions/base.js`, which carries
 * `0xca11bde05977b3631167028862be2a173976ca11` with `blockCreated: 5022`. Kept
 * in EIP-55 checksum casing — the same address, and the capitalisation is itself
 * a check on a value that was copied by hand.
 *
 * This one is a genesis preinstall, so it has real EVM bytecode and
 * `eth_getCode` returns it. The B20 token addresses do not work that way; see
 * `ethGetCode` below.
 */
export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Public Base endpoints, used in rotation. */
export const BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
] as const;

/**
 * The minimum viem needs to read: an id, a name for its error messages, the
 * native currency, a default endpoint list, and where Multicall3 lives.
 * `multicall()` reads that last one off the chain, which is the only reason the
 * chain object is passed to the client at all.
 */
const BASE_CHAIN = {
  id: BASE_CHAIN_ID,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: BASE_RPC_URLS } },
  contracts: {
    multicall3: { address: MULTICALL3_ADDRESS, blockCreated: 5022 },
  },
} as const satisfies Chain;

/** Delay between serialised reads, when reads cannot be batched. */
export const READ_DELAY_MS = 300;

const REQUEST_TIMEOUT_MS = 12_000;

let rotation = 0;

/**
 * The endpoint list, rotated one position per call.
 *
 * A dedicated endpoint in `NEXT_PUBLIC_BASE_RPC_URL` always goes first — it has
 * the headroom the public ones do not, and the public list stays as fallback.
 */
export function rotatedRpcUrls(): string[] {
  const offset = rotation++ % BASE_RPC_URLS.length;
  const rotated = [
    ...BASE_RPC_URLS.slice(offset),
    ...BASE_RPC_URLS.slice(0, offset),
  ];

  const dedicated = process.env.NEXT_PUBLIC_BASE_RPC_URL;
  return dedicated ? [dedicated, ...rotated] : rotated;
}

/**
 * A read-only Base client that fails over across endpoints.
 *
 * Built per call rather than once at module scope, so the rotation actually
 * rotates. Client construction is cheap; a rate-limited endpoint is not.
 */
export function basePublicClient() {
  return createPublicClient({
    chain: BASE_CHAIN,
    transport: fallback(
      rotatedRpcUrls().map((url) =>
        http(url, { timeout: REQUEST_TIMEOUT_MS, retryCount: 1 }),
      ),
    ),
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Hex = `0x${string}`;

/**
 * One raw JSON-RPC request, against one endpoint.
 *
 * Deliberately low-level, and shared by the two helpers below so the timeout,
 * the HTTP check and the error shape live in one place. `subject` appears only in
 * error messages — the address the caller was asking about, so a failure names
 * it.
 */
async function rpcRequest(
  url: string,
  method: string,
  params: readonly unknown[],
  subject: string,
): Promise<Hex> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    const payload = body as { result?: string; error?: { message?: string } };

    if (payload.error) {
      throw new Error(`${url} returned ${payload.error.message ?? "an error"}`);
    }

    if (typeof payload.result !== "string" || !payload.result.startsWith("0x")) {
      throw new Error(`${url} returned no result for ${method} ${subject}`);
    }

    return payload.result as Hex;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One `eth_call`, by raw selector.
 *
 * The verify script reads `symbol()` this way so that nothing in our own
 * encoding layer can make a wrong address look right.
 */
export function ethCall(url: string, to: string, data: Hex): Promise<Hex> {
  return rpcRequest(url, "eth_call", [{ to, data }, "latest"], to);
}

/**
 * The deployed bytecode at an address, or `0x` when there is none.
 *
 * `0x` does not on its own mean an address is wrong. Base carries two kinds of
 * built-in contract, and they answer this call differently:
 *
 * - **Preinstalls** are written into the genesis state and are ordinary EVM
 *   contracts. Multicall3 is one, so it returns bytecode here.
 * - **Precompiles** run as native client code outside the EVM. Calls to them
 *   work normally, but there is no bytecode at the address, so this returns
 *   `0x`.
 *
 * The B20 tokenized stocks sit in the `0xb2…` precompile range. If they are true
 * precompiles, an empty result here says nothing about whether the address is
 * real — reading `symbol()` off it does.
 */
export function ethGetCode(url: string, address: string): Promise<Hex> {
  return rpcRequest(url, "eth_getCode", [address, "latest"], address);
}
