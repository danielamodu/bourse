import type { Address } from "viem";

/**
 * Token address shape check.
 *
 * Counterfeit tokenized stocks are live on Base right now — fake NVDAc and
 * GOOGLc pairs on Uniswap, one showing $610,081 of liquidity against $4 of
 * daily volume. A user cannot tell them apart by symbol, and neither can a
 * symbol search, which is why we never do one.
 *
 * Real Coinbase tokenized stocks are Base precompiles: `0xb2` followed by
 * twenty zeros, then eighteen hex characters. The long run of zeros is what
 * makes the pattern worth trusting — vanity mining can buy you a `0xb2` prefix
 * for pennies, but not twenty leading zero nibbles.
 *
 * This is a shape check, not a registry check. It rejects a counterfeit; it
 * cannot confirm that a well-shaped address is the token you meant. Pair it
 * with the address in `lib/tokens.ts`, which is verified on-chain by reading
 * `symbol()` back from each contract.
 */

/** `0xb2` + 20 zeros + 18 hex characters = 42 characters including `0x`. */
const TOKEN_ADDRESS_SHAPE = /^0xb20{20}[0-9a-f]{18}$/;

/**
 * True only for an address in the tokenized-stock precompile range.
 *
 * Case-insensitive: an EIP-55 checksummed address may capitalise any hex
 * letter, so the input is lowercased before matching rather than requiring one
 * particular casing.
 */
export function isValidTokenAddress(
  value: string | null | undefined,
): value is Address {
  if (typeof value !== "string") return false;
  return TOKEN_ADDRESS_SHAPE.test(value.toLowerCase());
}

/**
 * Hard-fails on anything that is not a tokenized-stock address.
 *
 * Call this at every boundary where an address becomes an on-chain action — a
 * price read, a quote, an approval, a transfer. Throwing is the point: a
 * wrong-shaped address here means either a bad edit or an attempt to route a
 * user into a counterfeit pool, and both should stop the operation dead rather
 * than degrade into a silent no-op.
 */
export function assertValidTokenAddress(
  value: string | null | undefined,
  context: string,
): Address {
  if (!isValidTokenAddress(value)) {
    throw new Error(
      `${context}: refusing to use ${String(value)} as a tokenized stock address. ` +
        "Expected 0xb2 followed by 20 zeros and 18 hex characters.",
    );
  }

  return value;
}
