import { decodeAbiParameters, hexToString } from "viem";
import { describe, expect, it } from "vitest";

import { isValidTokenAddress } from "@/lib/address";
import {
  BASE_RPC_URLS,
  MULTICALL3_ADDRESS,
  READ_DELAY_MS,
  ethCall,
  ethGetCode,
  sleep,
} from "@/lib/rpc";
import { CHAINLINK_FEEDS, STOCK_SYMBOLS, TRADEABLE_TOKENS } from "@/lib/tokens";

/**
 * Every hardcoded address in the repo, checked against Base.
 *
 * Not part of `npm test`. This makes real network calls, so it lives behind
 * `npm run verify:chain` and is run deliberately after an address or ABI change.
 * A suite that goes red because a public RPC rate-limited would train us to
 * ignore red.
 *
 * Two kinds of check, because Base has two kinds of built-in contract:
 *
 * - **Feeds and Multicall3** are ordinary contracts — Multicall3 is a genesis
 *   preinstall, the Chainlink feeds are deployed normally. Both have EVM
 *   bytecode, so `eth_getCode` returning `0x` means the address is wrong. That
 *   is the assertion.
 * - **The four B20 tokens** sit in the `0xb2…` precompile range. A precompile
 *   runs as native client code outside the EVM and has no bytecode at its
 *   address, so `eth_getCode` can legitimately return `0x` for a contract that
 *   answers calls perfectly well. Their passing condition is a successful
 *   `symbol()` returning the expected ticker. Their code is reported for
 *   information only — if it ever comes back non-empty, tighten this then.
 *
 * A `0x` against a token address is not evidence of a problem. Those four are
 * already established three other ways: sourced from base.org/stocks, shape
 * checked against `0xb2` + 20 zeros + 18 hex, and confirmed by reading
 * `symbol()` back off each one.
 *
 * Reads are serialised with a delay and rotate across endpoints, because
 * `mainnet.base.org` rate-limits after roughly a dozen calls in quick
 * succession and this file makes about thirty.
 */

/** `symbol()`. */
const SYMBOL_SELECTOR = "0x95d89b41";

/** `decimals()`. */
const DECIMALS_SELECTOR = "0x313ce567";

/** Contracts that must have bytecode. One line per address below. */
const DEPLOYED: ReadonlyArray<readonly [string, string]> = [
  ...STOCK_SYMBOLS.map(
    (symbol) => [`${symbol} feed`, CHAINLINK_FEEDS[symbol]] as const,
  ),
  ["Multicall3", MULTICALL3_ADDRESS],
];

const EXPECTED_SYMBOLS = [
  ["NVDA", "NVDAc"],
  ["GOOGL", "GOOGLc"],
  ["AAPL", "AAPLc"],
  ["META", "METAc"],
] as const satisfies ReadonlyArray<
  readonly [keyof typeof TRADEABLE_TOKENS, string]
>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ERC-20 `symbol()` returns a dynamic string; a few old tokens return bytes32. */
function decodeSymbol(data: `0x${string}`): string {
  try {
    const [value] = decodeAbiParameters([{ type: "string" }] as const, data);
    if (typeof value === "string") return value;
  } catch {
    // Not a dynamic string. Fall through and read it as bytes32.
  }

  return hexToString(data, { size: 32 }).replace(/ +$/, "");
}

/** `decimals()` returns uint8, which viem decodes to a number. */
function decodeDecimals(data: `0x${string}`): number {
  const [value] = decodeAbiParameters([{ type: "uint8" }] as const, data);
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`decimals() returned ${String(value)}, not a number`);
}

let callCount = 0;

/**
 * Runs one read, starting from a different endpoint each time and falling
 * through the rest only if that one fails. The delay goes before every attempt,
 * including retries, so a rate-limited endpoint is not immediately hammered.
 */
async function fromAnyEndpoint<T>(
  label: string,
  read: (url: string) => Promise<T>,
): Promise<{ url: string; value: T }> {
  const start = callCount++;
  const failures: string[] = [];

  for (let offset = 0; offset < BASE_RPC_URLS.length; offset += 1) {
    const url = BASE_RPC_URLS[(start + offset) % BASE_RPC_URLS.length];
    if (url === undefined) continue;

    await sleep(READ_DELAY_MS);

    try {
      return { url, value: await read(url) };
    } catch (error) {
      failures.push(`${url} — ${describeError(error)}`);
    }
  }

  throw new Error(
    `could not read ${label} from any endpoint:\n  ${failures.join("\n  ")}`,
  );
}

/**
 * One test per address, so a failure names the contract rather than an index.
 * Empty bytecode here means the address is wrong: none of these are precompiles.
 */
describe("contracts with bytecode: 13 feeds and Multicall3", () => {
  for (const [label, address] of DEPLOYED) {
    it(`${label} — ${address}`, async () => {
      const { value: code, url } = await fromAnyEndpoint(
        `eth_getCode at ${address}`,
        (rpcUrl) => ethGetCode(rpcUrl, address),
      );

      expect(
        code,
        `${label}: nothing is deployed at ${address} (via ${url})`,
      ).not.toBe("0x");
    });
  }
});

/**
 * The four token addresses were transcribed by hand, and a wrong one would point
 * a buy at some other contract — counterfeit NVDAc and GOOGLc tokens with
 * six-figure fake liquidity are live on Base right now. Reading `symbol()` back
 * off the address is what verifies the transcription.
 */
describe("tokenized stock contracts: symbol() must match", () => {
  for (const [symbol, expected] of EXPECTED_SYMBOLS) {
    const address = TRADEABLE_TOKENS[symbol];

    it(`${expected} — ${address}`, async () => {
      // Never read from an address that fails the shape check.
      expect(isValidTokenAddress(address), `${symbol} address shape`).toBe(true);

      const { value: data, url } = await fromAnyEndpoint(
        `symbol() at ${address}`,
        (rpcUrl) => ethCall(rpcUrl, address, SYMBOL_SELECTOR),
      );
      const onChain = decodeSymbol(data);

      expect(
        onChain,
        `${symbol}: ${address} reported symbol() as "${onChain}" via ${url}, expected "${expected}"`,
      ).toBe(expected);

      // Reported, never asserted: `0x` is the expected answer for a precompile
      // and says nothing about whether this address is real.
      const { value: code } = await fromAnyEndpoint(
        `eth_getCode at ${address}`,
        (rpcUrl) => ethGetCode(rpcUrl, address),
      );

      console.info(
        `  ${expected} ${address} — symbol() "${onChain}", eth_getCode ${
          code === "0x"
            ? "0x (precompile: no EVM bytecode, as expected)"
            : `${(code.length - 2) / 2} bytes — not a bare precompile, worth tightening this check`
        }`,
      );
    });
  }
});

/**
 * Token `decimals()`, read rather than assumed.
 *
 * Every share count the buy flow shows rests on this number, and the 8 we have
 * been working from was inferred from arithmetic on a KyberSwap response, not
 * read off the contract. B20 has configurable precision, so it is a per-token
 * property. This prints what each one actually returns.
 *
 * It deliberately does not assert 8 — that would encode the guess as a
 * requirement. It asserts only that the answer is an integer we can scale with,
 * inside the bound `scaleBigInt` in lib/price accepts. Note this is the *token's*
 * decimals; the Chainlink feeds return 8 from their own `decimals()`, which is a
 * different number on a different contract.
 */
describe("token decimals(): read, not assumed", () => {
  for (const [symbol, expected] of EXPECTED_SYMBOLS) {
    const address = TRADEABLE_TOKENS[symbol];

    it(`${expected} decimals()`, async () => {
      expect(isValidTokenAddress(address), `${symbol} address shape`).toBe(true);

      const { value: data, url } = await fromAnyEndpoint(
        `decimals() at ${address}`,
        (rpcUrl) => ethCall(rpcUrl, address, DECIMALS_SELECTOR),
      );
      const decimals = decodeDecimals(data);

      console.info(`  ${expected} ${address} — decimals() = ${decimals}`);

      if (decimals !== 8) {
        console.info(
          `    ^ not 8. Order sizing and share counts for ${expected} must use ${decimals}.`,
        );
      }

      expect(
        Number.isInteger(decimals),
        `${expected}: decimals() returned ${decimals} via ${url}`,
      ).toBe(true);
      expect(decimals).toBeGreaterThanOrEqual(0);
      expect(decimals).toBeLessThanOrEqual(36);
    });
  }
});
