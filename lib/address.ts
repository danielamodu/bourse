import { getAddress, type Address } from "viem";

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

/** Any address, in any casing. Forty hex characters and nothing else. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/** All zeros. A sentinel, never an account, and never a recipient. */
const ZERO_ADDRESS_SHAPE = /^0x0{40}$/;

/**
 * A wallet address, canonicalised, or null.
 *
 * For the addresses that are *not* tokens: the `sender` of a swap, and therefore
 * the recipient of everything it buys. {@link isValidTokenAddress} must not be used
 * on one — a wallet is not a `0xb2…` precompile and would fail that shape — and
 * this must not be used on a token, because forty hex characters is precisely the
 * check that a counterfeit passes. They are different questions about different
 * kinds of address; CLAUDE.md keeps feed, token and ordinary addresses apart for
 * the same reason.
 *
 * WHAT IT RETURNS is the canonical EIP-55 form, not the string it was given. The
 * value goes into a request body as both `sender` and `recipient`, so normalising
 * once here means every downstream comparison is against one spelling.
 *
 * WHY CASING IS CHECKED. A mixed-case address carries a transcription check: the
 * pattern of upper and lower case is derived from the address's own keccak hash, so
 * one wrong character stops matching it. That check is worth running here more than
 * anywhere else in the app, because the swap's output goes to this address and
 * nowhere else — a mangled sender does not fail loudly, it buys shares for an
 * account nobody holds the key to. So a mixed-case address must already be
 * canonical, while an all-lowercase or all-uppercase one is accepted and
 * canonicalised: those carry no case information to check, and refusing them would
 * reject addresses that are merely written plainly.
 *
 * The zero address is refused outright. It is well-shaped, it passes any checksum
 * test, and it is what an uninitialised field serialises to.
 */
export function parseAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!ADDRESS_SHAPE.test(trimmed)) return null;
  if (ZERO_ADDRESS_SHAPE.test(trimmed)) return null;

  // Lowercased first, deliberately. `getAddress` derives the casing from the
  // address's own hash but leaves characters it does not need to uppercase exactly
  // as it found them, so handing it an all-uppercase address returns an
  // all-uppercase address. From a lowercase input it returns the canonical form.
  const canonical = getAddress(trimmed.toLowerCase());

  const body = trimmed.slice(2);
  const carriesChecksum =
    body !== body.toLowerCase() && body !== body.toUpperCase();

  if (carriesChecksum && canonical !== trimmed) return null;

  return canonical;
}
