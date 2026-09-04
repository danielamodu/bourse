import type { Address } from "viem";

import { assertValidTokenAddress } from "@/lib/address";
import { mapKeys } from "@/lib/map-keys";

/**
 * The 13 Coinbase tokenized stocks on Base.
 *
 * Issued is not the same as tradeable. All 13 contracts exist and all 13 have
 * working Chainlink feeds; as measured on 2026-09-03 only four had a pool
 * anywhere on Base. That measurement is not stored here. **This registry holds
 * no tradeability flag** — whether a token can be bought is decided by asking
 * KyberSwap for a quote at the user's actual order size (`lib/quote.ts`,
 * `lib/tradeability.ts`), because depth is set by weekly Aerodrome gauge votes
 * and an authored list goes stale between them.
 *
 * What the registry does record is whether an address has been *published*,
 * which is a different and durable fact: nine of the thirteen have no address to
 * quote against, so they cannot be asked about at all.
 *
 * SOURCING — addresses are copied from a verified source, never guessed:
 *
 * - Chainlink feeds: all 13 verified on 2026-09-03 by calling `description()`
 *   on each address and matching the result against the ticker, plus
 *   `decimals()` (8 on every one) and `latestRoundData()`. Recorded in
 *   CLAUDE.md and copied here verbatim.
 *
 * - Token contracts: the four whose addresses Coinbase has published, from
 *   base.org/stocks. The other nine contracts exist but their addresses are not
 *   published, so their `address` is null and no read is attempted against them.
 *   Verified by `verify/chain.verify.ts` (`npm run verify:chain`), which reads
 *   `symbol()` back off each of the four — they were transcribed by hand, so
 *   that check is what stands behind them. No address ships on the strength of
 *   looking right.
 *
 * Feed addresses and token addresses are different contracts and must never be
 * swapped: token addresses sit in the `0xb2…` precompile range, feed addresses
 * look like ordinary contracts.
 */

export const STOCK_SYMBOLS = [
  "AAPL",
  "AMZN",
  "COIN",
  "CRCL",
  "GOOGL",
  "INTC",
  "META",
  "MSFT",
  "MSTR",
  "NVDA",
  "SNDK",
  "SPCX",
  "TSLA",
] as const;

export type StockSymbol = (typeof STOCK_SYMBOLS)[number];

/**
 * Chainlink reference feeds. Verbatim from CLAUDE.md — do not re-source or
 * reformat these; each one was confirmed by reading `description()` off it.
 */
export const CHAINLINK_FEEDS = {
  AAPL: "0x787F13dEa48Db0897CbCDD985de77809D837F988",
  AMZN: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
  COIN: "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7",
  CRCL: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33",
  GOOGL: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
  INTC: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB",
  META: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
  MSFT: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
  MSTR: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
  NVDA: "0x04689a41629776563E6822F76f2e57D148d28513",
  SNDK: "0x388b0dC46C0Fb05A74BeE0994Fa5b02c6Fcca2eA",
  SPCX: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
  TSLA: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
} as const satisfies Record<StockSymbol, Address>;

/**
 * The four token addresses Coinbase has published, from base.org/stocks.
 *
 * Not a tradeability list — see the note at the top of this file. It is the list
 * of tokens we have an address for, and therefore the list we are able to ask an
 * aggregator about. The remaining nine are issued but unpublished, so there is
 * nothing to quote against.
 *
 * Each of the four was transcribed by hand and is checked two ways before it can
 * ship: the shape assertion below, at import time, and `symbol()` read back off
 * the contract in `verify/chain.verify.ts`.
 */
export const TOKEN_ADDRESSES = {
  NVDA: "0xb20000000000000000000078ee7ce2fE4908108C",
  GOOGL: "0xb2000000000000000000002D0BA3164cc74f58B7",
  AAPL: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  META: "0xb2000000000000000000008bC8786B856E61707C",
} as const;

/** A symbol we hold an address for, and so can request a quote for. */
export type QuotableSymbol = keyof typeof TOKEN_ADDRESSES;

/**
 * The same four as an array, for iterating.
 *
 * `Object.keys` widens to `string[]`, so the key type is restored by assertion
 * here — once, in the file that owns the object — rather than at each call site.
 * `lib/tokens.test.ts` pins this back to `TOKEN_ADDRESSES` so the two cannot
 * drift.
 */
export const QUOTABLE_SYMBOLS = Object.keys(
  TOKEN_ADDRESSES,
) as QuotableSymbol[];

/**
 * Token `decimals()`, read from each contract — not assumed, and not shared with
 * the feeds.
 *
 * PROVENANCE: verified on-chain 2026-09-03 by `npm run verify:chain`, which
 * `eth_call`s `decimals()` (selector `0x313ce567`) against each of these four
 * addresses. All four return 8. Before that it was inferred from arithmetic on a
 * KyberSwap response, which is why it is written down here with the source named:
 * every share count the buy flow displays is scaled by this number, so a wrong
 * value is off by orders of magnitude and looks plausible.
 *
 * Recorded per token rather than as one constant because B20 precision is a
 * per-token setting. A fifth token gets its own read; it does not inherit this 8.
 *
 * The Chainlink feeds also return 8 from their own `decimals()`. That is a
 * coincidence of two conventions, not one shared value — `lib/read-prices.ts`
 * reads the feed's separately and neither is ever substituted for the other.
 */
export const TOKEN_DECIMALS = {
  NVDA: 8,
  GOOGL: 8,
  AAPL: 8,
  META: 8,
} as const satisfies Record<QuotableSymbol, number>;

/**
 * USDC on Base, the currency every quote is denominated in.
 *
 * Internal plumbing: naira is what the user reads, and USDC only exists because
 * that is what the pools price against. `lib/quote.ts` converts NGN to a USDC
 * `amountIn` and back again.
 *
 * This is an ordinary ERC-20, not a `0xb2…` precompile, so `isValidTokenAddress`
 * does not and must not apply to it. It is machine-verified in
 * `verify/chain.verify.ts` the way every other hardcoded address is: bytecode
 * present, `symbol()` reads back `USDC`, `decimals()` reads back 6.
 */
export const USDC_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** USDC's own precision. Asserted against the contract in `verify:chain`. */
export const USDC_DECIMALS = 6;

/**
 * Shape-check the hardcoded token addresses at import time.
 *
 * These values are static, so a failure here is a bad edit, not a runtime
 * condition — it breaks the build rather than reaching a user. That is the
 * intent: a mistyped token address must never ship.
 */
for (const [symbol, address] of Object.entries(TOKEN_ADDRESSES)) {
  assertValidTokenAddress(address, `TOKEN_ADDRESSES.${symbol}`);
}

/**
 * True when we hold a published address for this symbol.
 *
 * A type predicate rather than a boolean so callers holding a `StockSymbol` — a
 * route param, a card key — can reach `TOKEN_ADDRESSES` and `TOKEN_DECIMALS`
 * without a cast. Necessary for a quote, never sufficient: it says an address
 * exists to ask about, not that the answer will be yes.
 */
export function isQuotableSymbol(
  symbol: StockSymbol,
): symbol is QuotableSymbol {
  return symbol in TOKEN_ADDRESSES;
}

/** Company names as a person would say them. */
const COMPANY_NAMES: Record<StockSymbol, string> = {
  AAPL: "Apple",
  AMZN: "Amazon",
  COIN: "Coinbase",
  CRCL: "Circle",
  GOOGL: "Alphabet",
  INTC: "Intel",
  META: "Meta",
  MSFT: "Microsoft",
  MSTR: "Strategy",
  NVDA: "NVIDIA",
  SNDK: "SanDisk",
  // TODO(phase-3): confirm the issuer behind SPCX. Every other entry maps to a
  // listed company; this ticker does not, so it shows the bare ticker rather
  // than a name we invented.
  SPCX: "SPCX",
  TSLA: "Tesla",
};

export type StockToken = {
  /** Underlying ticker. Used in URLs and as the registry key. */
  symbol: StockSymbol;
  /** On-chain ticker: the underlying ticker plus a `c` suffix. */
  tokenSymbol: string;
  /** Company name as a person would say it. */
  name: string;
  /** B20 token contract, or null where the address is not published. */
  address: Address | null;
  /**
   * The token's own `decimals()`, or null alongside a null address.
   *
   * Verified per token — see {@link TOKEN_DECIMALS}. Nullable in step with
   * `address` because an unpublished token has no contract to have read it from,
   * and inventing an 8 for it would be the exact assumption that rule forbids.
   */
  decimals: number | null;
  /** Chainlink reference feed. A separate contract from the token. */
  feedAddress: Address;
};

export const STOCK_TOKENS: Record<StockSymbol, StockToken> = mapKeys(
  STOCK_SYMBOLS,
  (symbol) =>
    ({
      symbol,
      tokenSymbol: `${symbol}c`,
      name: COMPANY_NAMES[symbol],
      address: isQuotableSymbol(symbol) ? TOKEN_ADDRESSES[symbol] : null,
      decimals: isQuotableSymbol(symbol) ? TOKEN_DECIMALS[symbol] : null,
      feedAddress: CHAINLINK_FEEDS[symbol],
    }) satisfies StockToken,
);

/**
 * Every token, alphabetically.
 *
 * Deliberately not sorted by tradeability. Nothing at module scope knows which
 * tokens an aggregator will quote, and sorting here would need a flag to sort by —
 * which is the flag we removed. The markets page groups and orders these from the
 * quote probe it runs per render.
 */
export const STOCK_LIST: StockToken[] = STOCK_SYMBOLS.map(
  (symbol) => STOCK_TOKENS[symbol],
);

/**
 * The tokens there is any point asking an aggregator about.
 *
 * A published address is necessary for a quote and nowhere near sufficient: this
 * is the input to the tradeability probe, never a substitute for its answer.
 */
export const QUOTABLE_LIST: StockToken[] = STOCK_LIST.filter(
  (token) => token.address !== null,
);

export function isStockSymbol(value: string): value is StockSymbol {
  return (STOCK_SYMBOLS as readonly string[]).includes(value);
}

export function findStock(value: string): StockToken | null {
  const upper = value.toUpperCase();
  return isStockSymbol(upper) ? STOCK_TOKENS[upper] : null;
}
