import { describe, expect, it } from "vitest";

import {
  formatFeedAge,
  formatNGN,
  formatUSD,
  NGN_PLACEHOLDER,
  USD_PLACEHOLDER,
} from "./format";

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
