import { describe, expect, it } from "vitest";

import {
  formatAddressShort,
  formatBourseFee,
  formatChainName,
  formatConnectorName,
  formatCostBps,
  formatFeedAge,
  formatNGN,
  formatNGNAmount,
  formatPremiumBps,
  formatQuoteCountdown,
  formatShares,
  formatSpread,
  formatUSD,
  NGN_PLACEHOLDER,
  parseNgnAmount,
  SHARES_PLACEHOLDER,
  USD_PLACEHOLDER,
} from "./format";
import { USDC_ADDRESS } from "@/lib/tokens";

const RATE = 1_500;

// ICU puts a non-breaking space after the currency marker in some versions, and
// falls back to the "NGN" code when the en-NG symbol is unavailable. Normalise
// whitespace and stay tolerant about the marker, so an ICU bump cannot break
// these; the digits themselves are asserted exactly.
const normalise = (value: string) => value.replace(/\s/g, " ");
const ngn = (digits: string) => new RegExp(`^-?(?:₦ ?|NGN )${digits}$`);

describe("formatNGN", () => {
  it("formats zero as a real amount, not a placeholder", () => {
    expect(normalise(formatNGN(0, RATE))).toMatch(ngn("0\\.00"));
  });

  it("groups a large amount", () => {
    expect(normalise(formatNGN(1_000_000, RATE))).toMatch(
      ngn("1,500,000,000\\.00"),
    );
  });

  it("returns the placeholder for NaN instead of throwing", () => {
    expect(() => formatNGN(Number.NaN, RATE)).not.toThrow();
    expect(formatNGN(Number.NaN, RATE)).toBe(NGN_PLACEHOLDER);
  });

  it("returns the placeholder when the rate is unusable", () => {
    expect(formatNGN(100, Number.NaN)).toBe(NGN_PLACEHOLDER);
    expect(formatNGN(100, 0)).toBe(NGN_PLACEHOLDER);
    expect(formatNGN(100, -1_500)).toBe(NGN_PLACEHOLDER);
  });

  it("returns the placeholder for non-finite results", () => {
    expect(formatNGN(Number.POSITIVE_INFINITY, RATE)).toBe(NGN_PLACEHOLDER);
    expect(formatNGN(Number.MAX_VALUE, RATE)).toBe(NGN_PLACEHOLDER);
  });

  it("formats a negative amount with a sign", () => {
    const formatted = normalise(formatNGN(-100, RATE));
    expect(formatted).toMatch(ngn("150,000\\.00"));
    expect(formatted.startsWith("-")).toBe(true);
  });

  it("does not render negative zero", () => {
    expect(normalise(formatNGN(-0, RATE)).startsWith("-")).toBe(false);
  });
});

describe("formatUSD", () => {
  it("formats zero and a large value", () => {
    expect(normalise(formatUSD(0))).toBe("$0.00");
    expect(normalise(formatUSD(1_000_000))).toBe("$1,000,000.00");
  });

  it("returns the placeholder for NaN instead of throwing", () => {
    expect(() => formatUSD(Number.NaN)).not.toThrow();
    expect(formatUSD(Number.NaN)).toBe(USD_PLACEHOLDER);
  });
});

describe("formatFeedAge", () => {
  const NOW = 1_772_000_000_000;
  const minutes = (count: number) => NOW - count * 60_000;
  const hours = (count: number) => NOW - count * 60 * 60_000;

  it("describes the verified spread of feed ages", () => {
    // The real range measured across the 13 feeds on one afternoon.
    expect(formatFeedAge(minutes(29), NOW)).toBe("29m old");
    expect(formatFeedAge(minutes(54), NOW)).toBe("54m old");
    expect(formatFeedAge(hours(13), NOW)).toBe("13h old");
    expect(formatFeedAge(minutes(14 * 60 + 53), NOW)).toBe("14h old");
  });

  it("rounds down rather than up, so an age never overstates itself", () => {
    expect(formatFeedAge(minutes(59), NOW)).toBe("59m old");
    expect(formatFeedAge(minutes(60), NOW)).toBe("1h old");
    expect(formatFeedAge(hours(23), NOW)).toBe("23h old");
    expect(formatFeedAge(hours(24), NOW)).toBe("1d old");
    expect(formatFeedAge(hours(49), NOW)).toBe("2d old");
  });

  it("reads a fresh or clock-skewed reading as under a minute", () => {
    expect(formatFeedAge(NOW, NOW)).toBe("under a minute old");
    expect(formatFeedAge(NOW - 59_999, NOW)).toBe("under a minute old");
    // A feed timestamp ahead of our clock must not render a negative age.
    expect(formatFeedAge(NOW + 5_000, NOW)).toBe("under a minute old");
  });

  it("returns null when there is no timestamp to describe", () => {
    expect(formatFeedAge(null, NOW)).toBeNull();
    expect(formatFeedAge(Number.NaN, NOW)).toBeNull();
    expect(formatFeedAge(NOW, Number.NaN)).toBeNull();
  });

  it("returns null when there is no clock to measure against yet", () => {
    // Before mount there is no trustworthy `Date.now()`, so no caption.
    expect(formatFeedAge(hours(13), null)).toBeNull();
  });
});

describe("formatNGNAmount", () => {
  it("keeps kobo below ₦1,000, where they still mean something", () => {
    expect(normalise(formatNGNAmount(999.5))).toMatch(ngn("999\\.50"));
    expect(normalise(formatNGNAmount(6.6))).toMatch(ngn("6\\.60"));
  });

  it("drops kobo from ₦1,000 up", () => {
    // Anchored, so a stray ".00" would fail these.
    expect(normalise(formatNGNAmount(1_000))).toMatch(ngn("1,000"));
    expect(normalise(formatNGNAmount(301_845))).toMatch(ngn("301,845"));
    expect(normalise(formatNGNAmount(1_650_000_000))).toMatch(
      ngn("1,650,000,000"),
    );
  });

  it("formats zero as an amount and never as negative zero", () => {
    expect(normalise(formatNGNAmount(0))).toMatch(ngn("0\\.00"));
    expect(normalise(formatNGNAmount(-0)).startsWith("-")).toBe(false);
  });

  it("returns the placeholder for null and for a non-number", () => {
    expect(formatNGNAmount(null)).toBe(NGN_PLACEHOLDER);
    expect(formatNGNAmount(Number.NaN)).toBe(NGN_PLACEHOLDER);
    expect(formatNGNAmount(Number.POSITIVE_INFINITY)).toBe(NGN_PLACEHOLDER);
  });
});

// ICU renders the minus sign as U+2212 in some versions. Fold it to a plain
// hyphen so the assertions below are about the figure, not the code point.
const signChars = (value: string) => value.replace(/−/g, "-");

describe("formatPremiumBps", () => {
  it("signs a premium and a discount", () => {
    // $600 executed against a $580 reference, and against $620 — the figures
    // `computePremiumBps` answers for those, which is -322 and not -323 now that
    // a discount rounds up in the signed sense too.
    expect(signChars(formatPremiumBps(345))).toBe("+3.45%");
    expect(signChars(formatPremiumBps(-322))).toBe("-3.22%");
    expect(signChars(formatPremiumBps(1_234))).toBe("+12.34%");
  });

  it("leaves an exact match unsigned", () => {
    // `signDisplay: "exceptZero"` — "+0.00%" would read as a movement.
    expect(formatPremiumBps(0)).toBe("0.00%");
  });

  it("keeps two places, so a small premium is still visible", () => {
    expect(signChars(formatPremiumBps(1))).toBe("+0.01%");
  });

  it("returns a dash when there is no premium to state", () => {
    // No quote yet, or no reference price to compare against.
    expect(formatPremiumBps(null)).toBe("—");
    expect(formatPremiumBps(Number.NaN)).toBe("—");
  });
});

describe("formatCostBps", () => {
  it("states a cost unsigned, because it is only ever a cost", () => {
    expect(formatCostBps(20)).toBe("0.20%");
    expect(formatCostBps(3_333)).toBe("33.33%");
    // A "+" here would read as movement in the user's favour.
    expect(formatCostBps(20).startsWith("+")).toBe(false);
  });

  it("states the measured band as plain percentages", () => {
    // 58 to 105bps across the four live tokens. This is what the row prints in
    // practice — the threshold branch below is the rare case, not this one.
    expect(formatCostBps(58)).toBe("0.58%");
    expect(formatCostBps(62)).toBe("0.62%");
    expect(formatCostBps(90)).toBe("0.90%");
    expect(formatCostBps(105)).toBe("1.05%");
  });

  it("states a cost below a basis point as a threshold, not as zero", () => {
    // `executionCostBps` rounds a cost up, so a zero arriving here means the route
    // costs less than two decimal places can state — including the clamped case,
    // where the two price lookups disagreed in the user's favour. An exact
    // "0.00%" between real naira figures reads as a figure that failed to load,
    // and "—" is reserved for exactly that.
    //
    // Unreachable for a market spread at real sizes: nothing in the 58 to 105bps
    // band lands here. It survives for the clamped unpriced-leg case, which is why
    // the branch is kept and why it is not the case the row is designed around.
    expect(formatCostBps(0)).toBe("under 0.01%");
    expect(formatCostBps(-50)).toBe("under 0.01%");

    // One basis point is the first figure it can state outright.
    expect(formatCostBps(1)).toBe("0.01%");
  });

  it("returns a dash when the route carried no figure", () => {
    expect(formatCostBps(null)).toBe("—");
    expect(formatCostBps(Number.NaN)).toBe("—");
  });
});

describe("formatSpread", () => {
  it("leads with the naira figure and puts the percentage beside it", () => {
    // ₦525 on a ₦50,000 ticket at 105bps. The naira figure comes first because it
    // is the one a person can weigh against what they were about to spend; 1.05%
    // of ₦50,000 is arithmetic they would have to do.
    const spread = formatSpread(525, 105);

    expect(spread).toBe(`${formatNGNAmount(525)} (1.05%)`);
    expect(spread.indexOf("525")).toBeLessThan(spread.indexOf("1.05"));
  });

  it("states the percentage alone when there is no rate yet", () => {
    // The cost is known either way, so the row says what it knows rather than
    // going blank.
    expect(formatSpread(null, 105)).toBe("1.05%");
    expect(formatSpread(Number.NaN, 58)).toBe("0.58%");
  });

  it("falls back to a dash when there is no figure at all", () => {
    // A naira spread with no percentage cannot arise: `spreadNgn` is derived from
    // the bps figure, so it is null whenever that is. Only the both-null case is
    // reachable, and it is the one the row starts in.
    expect(formatSpread(null, null)).toBe("—");
  });
});

describe("formatBourseFee", () => {
  it("reads zero as a statement, not as a missing figure", () => {
    // "₦0.00" in a column of naira amounts looks like a rounding artefact or a
    // failed load. "None" says we are not charging for this.
    expect(formatBourseFee(0)).toBe("None");
    expect(formatBourseFee(-0)).toBe("None");
  });

  it("formats a fee once there is one", () => {
    // The line people have always seen, the day it says something else.
    expect(formatBourseFee(125)).toBe(formatNGNAmount(125));
    expect(formatBourseFee(1_250)).toBe(formatNGNAmount(1_250));
  });

  it("returns the placeholder when there is no quote to take a figure from", () => {
    expect(formatBourseFee(null)).toBe(NGN_PLACEHOLDER);
    expect(formatBourseFee(Number.NaN)).toBe(NGN_PLACEHOLDER);
  });
});

describe("formatShares", () => {
  it("gives a small holding the places it needs", () => {
    // $30 of a $600 share. Five places, and the trailing zeros stay: they say
    // the figure is precise to there rather than padding it out.
    expect(formatShares(0.05)).toBe("0.05000");
    expect(formatShares(0.009_87)).toBe("0.009870");
  });

  it("does not collapse two different tickets into one figure", () => {
    // The reason the precision follows the magnitude. At two places both of
    // these read "0.05", which is the same answer for two different orders.
    expect(formatShares(0.05)).not.toBe(formatShares(0.0512));
  });

  it("switches precision at each band edge", () => {
    expect(formatShares(0.01)).toBe("0.01000");
    expect(formatShares(1)).toBe("1.0000");
    expect(formatShares(1_000)).toBe("1,000.00");
  });

  it("sheds places as the holding grows", () => {
    expect(formatShares(1.5)).toBe("1.5000");
    expect(formatShares(1_234.5)).toBe("1,234.50");
  });

  it("formats a zero holding without a sign", () => {
    expect(formatShares(0)).toBe("0.000000");
    expect(formatShares(-0).startsWith("-")).toBe(false);
  });

  it("returns the placeholder when there is no quote to take a figure from", () => {
    expect(formatShares(null)).toBe(SHARES_PLACEHOLDER);
    expect(formatShares(Number.NaN)).toBe(SHARES_PLACEHOLDER);
    expect(formatShares(Number.POSITIVE_INFINITY)).toBe(SHARES_PLACEHOLDER);
  });
});

describe("formatQuoteCountdown", () => {
  it("states a duration, singular and plural", () => {
    expect(formatQuoteCountdown(30)).toBe("30 seconds");
    expect(formatQuoteCountdown(2)).toBe("2 seconds");
    expect(formatQuoteCountdown(1)).toBe("1 second");
  });

  it("floors, so the time left is never overstated", () => {
    expect(formatQuoteCountdown(29.7)).toBe("29 seconds");
    expect(formatQuoteCountdown(1.9)).toBe("1 second");
  });

  it("says expired once there is nothing left, and never a negative", () => {
    expect(formatQuoteCountdown(0.4)).toBe("expired");
    expect(formatQuoteCountdown(0)).toBe("expired");
    expect(formatQuoteCountdown(-5)).toBe("expired");
    expect(formatQuoteCountdown(-0.1)).toBe("expired");
  });

  it("returns a dash before there is a quote to count down", () => {
    expect(formatQuoteCountdown(null)).toBe("—");
    expect(formatQuoteCountdown(Number.NaN)).toBe("—");
  });
});

describe("parseNgnAmount", () => {
  it("reads what people actually type", () => {
    expect(parseNgnAmount("50000")).toBe(50_000);
    expect(parseNgnAmount("50,000")).toBe(50_000);
    expect(parseNgnAmount("₦50,000")).toBe(50_000);
    expect(parseNgnAmount(" 50 000 ")).toBe(50_000);
    expect(parseNgnAmount("₦1,650,000,000")).toBe(1_650_000_000);
  });

  it("reads kobo and a partly typed decimal", () => {
    expect(parseNgnAmount("50000.75")).toBe(50_000.75);
    expect(parseNgnAmount("0.5")).toBe(0.5);
    // Mid-typing: "50." is 50 so far, not a rejection.
    expect(parseNgnAmount("50.")).toBe(50);
  });

  it("reads a half-typed amount as nothing yet", () => {
    // Null rather than zero: an empty field is not an order for nothing.
    for (const value of ["", " ", "₦", ".", "₦."]) {
      expect(parseNgnAmount(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("refuses an amount that cannot be spent", () => {
    for (const value of ["0", "00", "0.00", "-5000", "₦-5,000"]) {
      expect(parseNgnAmount(value), value).toBeNull();
    }
  });

  it("refuses anything it cannot read, rather than guessing a number", () => {
    for (const value of ["abc", "1e3", "50k", "5.0.0", "50,00.0.1", "1/2"]) {
      expect(parseNgnAmount(value), value).toBeNull();
    }
  });
});

describe("formatAddressShort", () => {
  it("shortens an address to both ends", () => {
    // Enough of each end to recognise a wallet you have seen before, which is all
    // this is for — it confirms which account is connected.
    expect(formatAddressShort(USDC_ADDRESS)).toBe("0x8335…2913");
    expect(formatAddressShort(USDC_ADDRESS)).toContain(USDC_ADDRESS.slice(0, 6));
    expect(formatAddressShort(USDC_ADDRESS)).toContain(USDC_ADDRESS.slice(-4));
  });

  it("keeps the casing it was given", () => {
    // Never lowercased: EIP-55 casing is the only thing a person could check by
    // eye against their wallet, and re-casing it would remove that.
    expect(formatAddressShort(USDC_ADDRESS.toLowerCase())).toBe("0x8335…2913");
    expect(formatAddressShort("0xAbCdEf0123456789012345678901234567890123")).toBe(
      "0xAbCd…0123",
    );
  });

  it("returns anything that is not address-shaped unchanged", () => {
    // Truncating a non-address into something that looks like one would be worse
    // than printing it: it would look verified.
    for (const value of ["", "0x", "not an address", "0x1234", `${USDC_ADDRESS}00`]) {
      expect(formatAddressShort(value), JSON.stringify(value)).toBe(value);
    }
  });

  it("returns a dash when no wallet is connected", () => {
    expect(formatAddressShort(null)).toBe("—");
  });
});

describe("formatChainName", () => {
  it("names the networks a wallet is likely to be on", () => {
    expect(formatChainName(8453)).toBe("Base");
    expect(formatChainName(1)).toBe("Ethereum");
    expect(formatChainName(137)).toBe("Polygon");
    expect(formatChainName(84_532)).toBe("Base Sepolia");
  });

  it("states an unknown id as a number rather than guessing", () => {
    // "network 1868" is a fact the user can act on or read out, and it does not
    // claim we know what we do not. Cosmetic either way: the one action offered
    // beside this sentence is switching to Base, whatever the answer.
    expect(formatChainName(1_868)).toBe("network 1868");
    expect(formatChainName(0)).toBe("network 0");
  });

  it("says another network when no chain was reported", () => {
    // The sentence still has to work.
    expect(formatChainName(null)).toBe("another network");
    expect(formatChainName(Number.NaN)).toBe("another network");
    expect(formatChainName(8_453.5)).toBe("another network");
  });
});

describe("formatConnectorName", () => {
  it("names the generic injected connector after where to find it", () => {
    // wagmi calls it "Injected", which is a word from EIP-1193 and not a wallet
    // anyone recognises. The button has to say where their wallet is.
    expect(formatConnectorName("Injected")).toBe("Browser Wallet");
  });

  it("leaves a wallet that named itself alone", () => {
    // EIP-6963 discovery gives one connector per installed wallet, each reporting
    // its own name. That name is what the user will see again inside the wallet
    // when it asks them to approve, so rewriting it would break the match.
    for (const name of ["MetaMask", "Trust Wallet", "Rabby", "Coinbase Wallet"]) {
      expect(formatConnectorName(name)).toBe(name);
    }
  });

  it("trims, and treats a nameless connector as the browser one", () => {
    // An unlabelled button is the same problem as a badly labelled one.
    expect(formatConnectorName("  MetaMask  ")).toBe("MetaMask");
    expect(formatConnectorName("")).toBe("Browser Wallet");
    expect(formatConnectorName("   ")).toBe("Browser Wallet");
  });

  it("does not rewrite a name that merely contains the word", () => {
    // Only the exact generic name is ours to replace. A wallet actually called
    // "Injected Wallet" would be a real product with a real name.
    expect(formatConnectorName("Injected Wallet")).toBe("Injected Wallet");
    expect(formatConnectorName("injected")).toBe("injected");
  });
});
