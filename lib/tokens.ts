import type { Address } from "viem";

import { assertValidTokenAddress } from "@/lib/address";
import { mapKeys } from "@/lib/map-keys";

/**
 * The 13 Coinbase tokenized stocks on Base.
 *
 * Issued is not the same as tradeable. All 13 contracts exist and all 13 have
 * working Chainlink feeds; only four have a pool anywhere on Base, so only four
 * can be bought. The other nine can show a reference price and nothing else.
 *
 * SOURCING — addresses are copied from a verified source, never guessed:
 *
 * - Chainlink feeds: all 13 verified on 2026-09-03 by calling `description()`
 *   on each address and matching the result against the ticker, plus
 *   `decimals()` (8 on every one) and `latestRoundData()`. Recorded in
 *   CLAUDE.md and copied here verbatim.
 *
 * - Token contracts: the four tradeable ones, from base.org/stocks. The other
 *   nine contracts exist but Coinbase has not published their addresses, so
 *   their `address` is null and no read is attempted against them.
 *   Verified by `lib/tokens.onchain.test.ts`, which reads `symbol()` back off
 *   each of the four — they were transcribed by hand, so that test is the check.
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
 * The four tokens with real liquidity on Base, ordered by depth as measured on
 * 2026-09-03: NVDA $2.5M, GOOGL $1.45M, AAPL $1.22M, META $926k.
 *
 * TEMPORARY. Tradeability is supposed to be derived at runtime — ask the
 * aggregator for a quote at the user's actual order size and treat the token as
 * tradeable only if price impact comes back inside budget. Depth is set by
 * weekly Aerodrome gauge votes, so this list will go stale. Delete it the moment
 * real quotes work (Phase 3).
 */
export const TRADEABLE_TOKENS = {
  NVDA: "0xb20000000000000000000078ee7ce2fE4908108C",
  GOOGL: "0xb2000000000000000000002D0BA3164cc74f58B7",
  AAPL: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  META: "0xb2000000000000000000008bC8786B856E61707C",
} as const;

export type TradeableSymbol = keyof typeof TRADEABLE_TOKENS;

/**
 * Shape-check the hardcoded addresses at import time.
 *
 * These values are static, so a failure here is a bad edit, not a runtime
 * condition — it breaks the build rather than reaching a user. That is the
 * intent: a mistyped token address must never ship.
 */
for (const [symbol, address] of Object.entries(TRADEABLE_TOKENS)) {
  assertValidTokenAddress(address, `TRADEABLE_TOKENS.${symbol}`);
}

function isTradeable(symbol: StockSymbol): symbol is TradeableSymbol {
  return symbol in TRADEABLE_TOKENS;
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
  /** Chainlink reference feed. A separate contract from the token. */
  feedAddress: Address;
  /** Provisional: see the note on TRADEABLE_TOKENS. Never authored per-token. */
  hasLiquidity: boolean;
};

export const STOCK_TOKENS: Record<StockSymbol, StockToken> = mapKeys(
  STOCK_SYMBOLS,
  (symbol) =>
    ({
      symbol,
      tokenSymbol: `${symbol}c`,
      name: COMPANY_NAMES[symbol],
      address: isTradeable(symbol) ? TRADEABLE_TOKENS[symbol] : null,
      feedAddress: CHAINLINK_FEEDS[symbol],
      hasLiquidity: isTradeable(symbol),
    }) satisfies StockToken,
);

/** Registry order for display: the tradeable four first, then alphabetical. */
export const STOCK_LIST: StockToken[] = STOCK_SYMBOLS.map(
  (symbol) => STOCK_TOKENS[symbol],
).sort((a, b) => {
  if (a.hasLiquidity !== b.hasLiquidity) return a.hasLiquidity ? -1 : 1;
  return a.symbol.localeCompare(b.symbol);
});

/** The markets page renders these as two groups. Membership is derived. */
export const TRADEABLE_LIST: StockToken[] = STOCK_LIST.filter(
  (token) => token.hasLiquidity,
);

export const LISTED_ONLY_LIST: StockToken[] = STOCK_LIST.filter(
  (token) => !token.hasLiquidity,
);

export function isStockSymbol(value: string): value is StockSymbol {
  return (STOCK_SYMBOLS as readonly string[]).includes(value);
}

export function findStock(value: string): StockToken | null {
  const upper = value.toUpperCase();
  return isStockSymbol(upper) ? STOCK_TOKENS[upper] : null;
}
