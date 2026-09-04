import { describe, expect, it } from "vitest";

import { isValidTokenAddress } from "@/lib/address";
import {
  CHAINLINK_FEEDS,
  QUOTABLE_LIST,
  QUOTABLE_SYMBOLS,
  STOCK_LIST,
  STOCK_SYMBOLS,
  STOCK_TOKENS,
  TOKEN_ADDRESSES,
  TOKEN_DECIMALS,
  findStock,
  isQuotableSymbol,
  isStockSymbol,
} from "@/lib/tokens";

/**
 * The registry's internal consistency.
 *
 * Not a check that the addresses are real — that is `verify/chain.verify.ts`,
 * which reads `symbol()` back off each contract, and `lib/address.test.ts`, which
 * asserts their shape. This file checks the things that go wrong when the registry
 * is *edited*: a fifth token added to one object and not another, a decimals entry
 * inheriting an 8 it was never read for, a feed address pasted into the token map.
 */

const QUOTABLE_COUNT = 4;
const LISTED_ONLY_COUNT = STOCK_SYMBOLS.length - QUOTABLE_COUNT;

describe("the symbol list", () => {
  it("holds the thirteen issued tickers, without duplicates", () => {
    expect(STOCK_SYMBOLS).toHaveLength(13);
    expect(new Set(STOCK_SYMBOLS).size).toBe(13);
  });

  it("has a company name and a feed for every one", () => {
    for (const symbol of STOCK_SYMBOLS) {
      const token = STOCK_TOKENS[symbol];

      expect(token.name.length, symbol).toBeGreaterThan(0);
      expect(token.feedAddress, symbol).toBe(CHAINLINK_FEEDS[symbol]);
      // The on-chain ticker carries a `c` suffix — the string verify:chain reads
      // back off each contract.
      expect(token.tokenSymbol, symbol).toBe(`${symbol}c`);
    }
  });
});

/**
 * `QUOTABLE_SYMBOLS` is `Object.keys(TOKEN_ADDRESSES)` with the key type asserted
 * back on, which is the one place in the registry where a cast stands in for a
 * check. This is that check.
 */
describe("QUOTABLE_SYMBOLS", () => {
  it("is exactly the keys of TOKEN_ADDRESSES", () => {
    expect([...QUOTABLE_SYMBOLS].sort()).toEqual(
      Object.keys(TOKEN_ADDRESSES).sort(),
    );
  });

  it("names only real symbols", () => {
    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(isStockSymbol(symbol), symbol).toBe(true);
      expect(isQuotableSymbol(symbol), symbol).toBe(true);
    }
  });

  it("is the four Coinbase has published an address for", () => {
    expect(QUOTABLE_SYMBOLS).toHaveLength(QUOTABLE_COUNT);
  });
});

describe("TOKEN_DECIMALS", () => {
  it("covers every quotable token and nothing else", () => {
    // A fifth token gets its own `decimals()` read. It does not inherit this 8,
    // which is why the two objects have to be kept in step.
    expect(Object.keys(TOKEN_DECIMALS).sort()).toEqual(
      Object.keys(TOKEN_ADDRESSES).sort(),
    );
  });

  it("records the 8 that verify:chain read off all four contracts", () => {
    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(TOKEN_DECIMALS[symbol], symbol).toBe(8);
    }
  });

  it("is not 18", () => {
    // B20 precision is configurable and these are not 18-decimal tokens.
    // Hardcoding 18 misstates every share count by ten orders of magnitude and
    // looks plausible while doing it.
    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(TOKEN_DECIMALS[symbol], symbol).not.toBe(18);
    }
  });
});

describe("STOCK_TOKENS", () => {
  it("nulls decimals exactly where it nulls the address", () => {
    // An unpublished token has no contract to have read a precision off, so
    // inventing one for it would be the assumption the registry forbids.
    for (const symbol of STOCK_SYMBOLS) {
      const { address, decimals } = STOCK_TOKENS[symbol];
      expect(address === null, symbol).toBe(decimals === null);
    }
  });

  it("carries the registry's address and precision for the published four", () => {
    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(STOCK_TOKENS[symbol].address, symbol).toBe(
        TOKEN_ADDRESSES[symbol],
      );
      expect(STOCK_TOKENS[symbol].decimals, symbol).toBe(
        TOKEN_DECIMALS[symbol],
      );
    }
  });

  it("leaves the other nine with nothing to quote against", () => {
    const unpublished = STOCK_SYMBOLS.filter(
      (symbol) => STOCK_TOKENS[symbol].address === null,
    );

    expect(unpublished).toHaveLength(LISTED_ONLY_COUNT);

    for (const symbol of unpublished) {
      expect(isQuotableSymbol(symbol), symbol).toBe(false);
      // A feed still exists for every one of them, which is what lets a
      // reference price render without a buy affordance.
      expect(STOCK_TOKENS[symbol].feedAddress, symbol).toBeTruthy();
    }
  });

  it("holds no tradeability flag", () => {
    // Depth is set by weekly gauge votes, so a flag here would be a measurement
    // with an expiry date stored as if it were a property. Tradeability is
    // derived from a quote in lib/tradeability.ts instead.
    for (const symbol of STOCK_SYMBOLS) {
      expect(STOCK_TOKENS[symbol]).not.toHaveProperty("hasLiquidity");
      expect(STOCK_TOKENS[symbol]).not.toHaveProperty("tradeable");
    }
  });
});

/**
 * The two address maps hold different contracts. A feed address where a token
 * address belongs would point a quote at a price oracle, and the shape guard is
 * what stops it — so the guard is asserted against every feed we ship.
 */
describe("token addresses versus feed addresses", () => {
  it("shares no address between the two maps", () => {
    const feeds = new Set(
      Object.values(CHAINLINK_FEEDS).map((address) => address.toLowerCase()),
    );

    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(
        feeds.has(TOKEN_ADDRESSES[symbol].toLowerCase()),
        symbol,
      ).toBe(false);
    }
  });

  it("keeps every feed outside the token shape", () => {
    for (const symbol of STOCK_SYMBOLS) {
      expect(isValidTokenAddress(CHAINLINK_FEEDS[symbol]), symbol).toBe(false);
    }
  });

  it("keeps every token inside it", () => {
    for (const symbol of QUOTABLE_SYMBOLS) {
      expect(isValidTokenAddress(TOKEN_ADDRESSES[symbol]), symbol).toBe(true);
    }
  });

  it("uses each address exactly once", () => {
    // A copy-paste that duplicated an address would otherwise quote one token
    // and label it another.
    const tokens = Object.values(TOKEN_ADDRESSES).map((a) => a.toLowerCase());
    const feeds = Object.values(CHAINLINK_FEEDS).map((a) => a.toLowerCase());

    expect(new Set(tokens).size).toBe(tokens.length);
    expect(new Set(feeds).size).toBe(feeds.length);
  });
});

describe("the rendered lists", () => {
  it("STOCK_LIST is every token in registry order", () => {
    // Deliberately not sorted by tradeability: nothing at module scope knows
    // which tokens an aggregator will quote. The markets page groups them from
    // the probe it runs per render.
    expect(STOCK_LIST.map((token) => token.symbol)).toEqual([...STOCK_SYMBOLS]);
  });

  it("QUOTABLE_LIST is the four with an address, in the same order", () => {
    expect(QUOTABLE_LIST).toHaveLength(QUOTABLE_COUNT);

    expect(QUOTABLE_LIST.map((token) => token.symbol)).toEqual(
      STOCK_LIST.filter((token) => token.address !== null).map(
        (token) => token.symbol,
      ),
    );

    for (const token of QUOTABLE_LIST) {
      expect(token.address, token.symbol).not.toBeNull();
      expect(token.decimals, token.symbol).not.toBeNull();
    }
  });
});

describe("looking a token up", () => {
  it("accepts only the thirteen tickers", () => {
    for (const symbol of STOCK_SYMBOLS) {
      expect(isStockSymbol(symbol), symbol).toBe(true);
    }

    expect(isStockSymbol("SPY")).toBe(false);
    expect(isStockSymbol("nvda")).toBe(false);
  });

  it("resolves a ticker in any casing", () => {
    expect(findStock("nvda")?.symbol).toBe("NVDA");
    expect(findStock("NVDA")?.symbol).toBe("NVDA");
    expect(findStock("Googl")?.symbol).toBe("GOOGL");
  });

  it("resolves the unpublished nine too", () => {
    // They have a page — reference price, no buy affordance — so they have to
    // resolve.
    expect(findStock("tsla")?.address).toBeNull();
  });

  it("returns null rather than guessing", () => {
    // Never resolve a token by symbol search: the on-chain ticker, a prefix and
    // an address all fail here, and only an exact underlying ticker resolves.
    for (const value of [
      "",
      "NVDAc",
      "NVD",
      "ETH",
      TOKEN_ADDRESSES.NVDA,
      CHAINLINK_FEEDS.NVDA,
    ]) {
      expect(findStock(value), value).toBeNull();
    }
  });
});
