import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { assertValidTokenAddress, isValidTokenAddress } from "@/lib/address";
import { KYBERSWAP_ROUTER_ADDRESS } from "@/lib/quote";
import { MULTICALL3_ADDRESS } from "@/lib/rpc";
import {
  CHAINLINK_FEEDS,
  STOCK_TOKENS,
  TOKEN_ADDRESSES,
  USDC_ADDRESS,
} from "@/lib/tokens";

const zeros = (count: number) => "0".repeat(count);

/** A well-shaped address, assembled rather than transcribed. */
const REAL = `0xb2${zeros(20)}78ee7ce2fE4908108C`;

/**
 * A counterfeit. Same `b2` prefix, no run of zeros — which is the point: the
 * prefix is cheap to vanity-mine, twenty leading zero nibbles are not.
 */
const COUNTERFEIT = "0xb2A4c1De9f3B8e07C25d6a4F19b3E8c05D72a1B6";

describe("isValidTokenAddress", () => {
  it("accepts a tokenized-stock precompile address", () => {
    expect(isValidTokenAddress(REAL)).toBe(true);
  });

  it("rejects a lookalike with the b2 prefix but no run of zeros", () => {
    expect(isValidTokenAddress(COUNTERFEIT)).toBe(false);
  });

  it("ignores checksum casing", () => {
    expect(isValidTokenAddress(REAL.toLowerCase())).toBe(true);
    expect(isValidTokenAddress(`0xB2${zeros(20)}78EE7CE2FE4908108C`)).toBe(true);
  });

  it("rejects too few zeros", () => {
    expect(isValidTokenAddress(`0xb2${zeros(19)}778ee7ce2fE4908108C`)).toBe(
      false,
    );
  });

  it("still accepts a longer run of zeros, by design", () => {
    // A zero is a valid hex digit, so 21 zeros reads as 20 zeros plus a hex
    // tail that happens to start with one. That is not a gap worth closing: the
    // guard exists to reject addresses with *too little* zero prefix, since
    // that is the part vanity mining can fake.
    expect(isValidTokenAddress(`0xb2${zeros(21)}8ee7ce2fE4908108C`)).toBe(true);
  });

  it("rejects the wrong prefix", () => {
    expect(isValidTokenAddress(`0xb3${zeros(20)}78ee7ce2fE4908108C`)).toBe(
      false,
    );
  });

  it("rejects the wrong length", () => {
    expect(isValidTokenAddress(`0xb2${zeros(20)}78ee7ce2fE4908108`)).toBe(false);
    expect(isValidTokenAddress(`0xb2${zeros(20)}78ee7ce2fE4908108CC`)).toBe(
      false,
    );
  });

  it("rejects non-hex characters", () => {
    expect(isValidTokenAddress(`0xb2${zeros(20)}78ee7ce2fZ4908108C`)).toBe(
      false,
    );
  });

  it("rejects a Chainlink feed address", () => {
    // Feeds are ordinary contracts. Passing one where a token is expected is the
    // exact mix-up this guard exists to stop.
    expect(isValidTokenAddress(CHAINLINK_FEEDS.NVDA)).toBe(false);
  });

  it("rejects absent and empty values", () => {
    expect(isValidTokenAddress(null)).toBe(false);
    expect(isValidTokenAddress(undefined)).toBe(false);
    expect(isValidTokenAddress("")).toBe(false);
    expect(isValidTokenAddress("0x")).toBe(false);
  });
});

describe("assertValidTokenAddress", () => {
  it("returns the address when the shape holds", () => {
    expect(assertValidTokenAddress(REAL, "test")).toBe(REAL);
  });

  it("throws with the calling context named", () => {
    expect(() => assertValidTokenAddress(COUNTERFEIT, "quote")).toThrow(
      /^quote: refusing to use/,
    );
  });

  it("throws on null rather than returning it", () => {
    expect(() => assertValidTokenAddress(null, "approval")).toThrow();
  });
});

/**
 * The transcription check.
 *
 * These four addresses were typed by hand, so this asserts the documented shape
 * on the actual registry values rather than on a copy. `verify/chain.verify.ts`
 * is the other half: it reads `symbol()` back off each contract.
 */
describe("TOKEN_ADDRESSES shape", () => {
  it("holds 0xb2 + 20 zeros + 18 hex characters on all four", () => {
    const entries = Object.entries(TOKEN_ADDRESSES);
    expect(entries).toHaveLength(4);

    for (const [symbol, address] of entries) {
      expect(address, symbol).toHaveLength(42);
      expect(address.slice(0, 4), symbol).toBe("0xb2");
      expect(address.slice(4, 24), symbol).toBe(zeros(20));
      expect(address.slice(24), symbol).toMatch(/^[0-9a-fA-F]{18}$/);
      expect(isValidTokenAddress(address), symbol).toBe(true);
    }
  });
});

/**
 * The checksum guard, over every address this repo pins.
 *
 * EIP-55 casing is cosmetic on the wire and load-bearing here. The pattern of upper
 * and lower case is derived from the address's own keccak hash, which makes it the
 * one transcription check an address carries: change a character and the pattern no
 * longer matches, at a residual risk EIP-55 itself puts at 0.0247%. Forty hex
 * characters is a shape that a mistyped address still has.
 *
 * So this is the cheap half of address safety, and the half that runs on every `npm
 * test`: a mistyped or mangled address fails here, offline, rather than three days
 * later as a call against nothing. `verify/chain.verify.ts` is the expensive half —
 * `symbol()` and `description()` read back off the contracts, an RPC, run
 * deliberately.
 *
 * A pinned address that fails is either that transcription error or a value copied
 * from a source that did not checksum it. Either way the fix is to canonicalise the
 * constant, never to lowercase it: lowercasing removes the check rather than
 * satisfying it.
 */
describe("every pinned address", () => {
  it("is in canonical EIP-55 checksum casing", () => {
    const pinned: readonly (readonly [string, string])[] = [
      ...Object.entries(CHAINLINK_FEEDS).map(
        ([symbol, feed]) => [`CHAINLINK_FEEDS.${symbol}`, feed] as const,
      ),
      // Both doors into the same values: the registry is built from the two maps
      // above, and a wrong address is equally wrong whichever one a caller reads.
      ...Object.entries(STOCK_TOKENS).flatMap(([symbol, token]) => [
        [`STOCK_TOKENS.${symbol}.feedAddress`, token.feedAddress] as const,
        ...(token.address === null
          ? []
          : [[`STOCK_TOKENS.${symbol}.address`, token.address] as const]),
      ]),
      ["USDC_ADDRESS", USDC_ADDRESS] as const,
      ["MULTICALL3_ADDRESS", MULTICALL3_ADDRESS] as const,
      ["KYBERSWAP_ROUTER_ADDRESS", KYBERSWAP_ROUTER_ADDRESS] as const,
    ];

    // 13 feeds + 13 registry feeds + 4 registry tokens + 3 singletons. Counted so a
    // fourteenth token cannot arrive without its addresses joining this guard.
    expect(pinned).toHaveLength(33);

    for (const [label, address] of pinned) {
      expect(address, label).toMatch(/^0x[0-9a-fA-F]{40}$/);
      // Equality, because `getAddress` re-derives the casing rather than validating
      // it — so this holds only when the constant is already canonical, and a
      // failure prints both strings.
      expect(getAddress(address), label).toBe(address);
    }
  });
});
