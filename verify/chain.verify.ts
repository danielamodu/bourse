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
import {
  CHAINLINK_FEEDS,
  STOCK_SYMBOLS,
  TOKEN_ADDRESSES,
  TOKEN_DECIMALS,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from "@/lib/tokens";

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
 * - **Feeds, Multicall3 and USDC** are ordinary contracts — Multicall3 is a
 *   genesis preinstall, the Chainlink feeds and USDC are deployed normally. All
 *   have EVM bytecode, so `eth_getCode` returning `0x` means the address is wrong.
 *   That is the assertion.
 * - **The four B20 tokens** sit in the `0xb2…` precompile range and run as native
 *   client code outside the EVM. They return **exactly one byte** here, which
 *   this suite established on 2026-09-03. One byte is the cheapest way to be
 *   non-empty, and non-empty is what the `isContract`-style check in most routers
 *   and every Permit2 path requires before it will handle a token — so the byte
 *   reads as deliberate compatibility, not as a contract body. Their passing
 *   condition is a successful `symbol()` returning the expected ticker. Their
 *   code is printed for information and never asserted on.
 *
 * That last point is deliberate and should stay that way: code size is useless as
 * an authenticity test in either direction. A counterfeit ERC-20 has a full
 * bytecode body, and the real tokens have one byte, so no threshold separates
 * them. Asserting on it here would put a check in the suite that looks like a
 * counterfeit guard and is not one. The shape test — `0xb2` + 20 zeros + 18 hex,
 * whose zero run cannot be vanity-mined — is the guard, and `symbol()` is what
 * confirms the transcription.
 *
 * Neither `0x` nor one byte against a token address is evidence of a problem.
 * Those four are established three other ways: sourced from base.org/stocks,
 * shape checked, and confirmed by reading `symbol()` back off each one.
 *
 * Reads are serialised with a delay and rotate across endpoints, because
 * `mainnet.base.org` rate-limits after roughly a dozen calls in quick
 * succession and this file makes about thirty-five.
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
  // USDC is an ordinary ERC-20, not a precompile, so it belongs in this group and
  // not with the four B20 tokens. Every quote is denominated in it.
  ["USDC", USDC_ADDRESS],
];

const EXPECTED_SYMBOLS = [
  ["NVDA", "NVDAc"],
  ["GOOGL", "GOOGLc"],
  ["AAPL", "AAPLc"],
  ["META", "METAc"],
] as const satisfies ReadonlyArray<
  readonly [keyof typeof TOKEN_ADDRESSES, string]
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
describe("contracts with bytecode: 13 feeds, Multicall3 and USDC", () => {
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
    const address = TOKEN_ADDRESSES[symbol];

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

      // Reported, never asserted. One byte is the expected answer, and code size
      // separates nothing from nothing here — see the header.
      const { value: code } = await fromAnyEndpoint(
        `eth_getCode at ${address}`,
        (rpcUrl) => ethGetCode(rpcUrl, address),
      );
      const codeBytes = (code.length - 2) / 2;
      const codeSize = `${codeBytes} byte${codeBytes === 1 ? "" : "s"}`;

      console.info(
        `  ${expected} ${address} — symbol() "${onChain}", eth_getCode ${codeSize}${
          codeBytes === 1
            ? " (expected: just enough to pass an isContract check)"
            : " — changed from the one byte verified 2026-09-03; worth noting, still not worth asserting"
        }`,
      );
    });
  }
});

/**
 * Token `decimals()`, read rather than assumed — and now asserted.
 *
 * Every share count the buy flow shows rests on this number. It began as a value
 * inferred from arithmetic on a KyberSwap response; on 2026-09-03 this suite read
 * it off all four contracts, all four returned 8, and `TOKEN_DECIMALS` in
 * lib/tokens records that with this script named as the provenance.
 *
 * Because the registry now hardcodes those numbers, the check inverts: it asserts
 * the contract still returns what the registry claims. B20 precision is a
 * per-token setting, so a token changing it — or a fifth token being added with a
 * different one — has to fail here rather than silently misprice every order by
 * orders of magnitude. Note this is the *token's* decimals; the Chainlink feeds
 * return 8 from their own `decimals()`, which is a different number on a
 * different contract and is never substituted for this one.
 */
describe("token decimals(): read and matched against the registry", () => {
  for (const [symbol, expected] of EXPECTED_SYMBOLS) {
    const address = TOKEN_ADDRESSES[symbol];
    const recorded = TOKEN_DECIMALS[symbol];

    it(`${expected} decimals() is ${recorded}`, async () => {
      expect(isValidTokenAddress(address), `${symbol} address shape`).toBe(true);

      const { value: data, url } = await fromAnyEndpoint(
        `decimals() at ${address}`,
        (rpcUrl) => ethCall(rpcUrl, address, DECIMALS_SELECTOR),
      );
      const decimals = decodeDecimals(data);

      console.info(`  ${expected} ${address} — decimals() = ${decimals}`);

      expect(
        decimals,
        `${expected}: contract returned ${decimals} via ${url}, registry records ${recorded}. Order sizing and every share count use the registry value, so fix lib/tokens before shipping.`,
      ).toBe(recorded);
    });
  }
});

/**
 * USDC, the currency every quote is denominated in.
 *
 * Hardcoded in lib/tokens like every other address, so it is machine-verified
 * like every other address. Its 6 decimals are what naira is converted into
 * before a quote goes out, so a wrong value here misstates every order size by a
 * factor of a hundred or more.
 */
describe("USDC on Base", () => {
  it(`symbol() is USDC — ${USDC_ADDRESS}`, async () => {
    const { value: data, url } = await fromAnyEndpoint(
      `symbol() at ${USDC_ADDRESS}`,
      (rpcUrl) => ethCall(rpcUrl, USDC_ADDRESS, SYMBOL_SELECTOR),
    );
    const onChain = decodeSymbol(data);

    expect(
      onChain,
      `${USDC_ADDRESS} reported symbol() as "${onChain}" via ${url}`,
    ).toBe("USDC");
  });

  it(`decimals() is ${USDC_DECIMALS}`, async () => {
    const { value: data, url } = await fromAnyEndpoint(
      `decimals() at ${USDC_ADDRESS}`,
      (rpcUrl) => ethCall(rpcUrl, USDC_ADDRESS, DECIMALS_SELECTOR),
    );
    const decimals = decodeDecimals(data);

    console.info(`  USDC ${USDC_ADDRESS} — decimals() = ${decimals}`);

    expect(
      decimals,
      `USDC returned ${decimals} via ${url}, lib/tokens records ${USDC_DECIMALS}`,
    ).toBe(USDC_DECIMALS);
  });
});
