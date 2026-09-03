/**
 * Display formatting. NGN is the figure users read; USD is plumbing that only
 * surfaces as a secondary reference.
 */

/** Shown instead of a number when the inputs cannot produce an honest amount. */
export const NGN_PLACEHOLDER = "₦—";
export const USD_PLACEHOLDER = "$—";

const ngnFormatter = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
});

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/**
 * Converts a USD amount to naira at `rate` and formats it.
 *
 * Returns {@link NGN_PLACEHOLDER} rather than throwing — or worse, rendering
 * a misleading `NGN 0.00` — when either input is not a usable number. A zero
 * or negative rate is treated as unusable; a zero or negative `usd` is not,
 * and formats normally.
 */
export function formatNGN(usd: number, rate: number): string {
  if (!Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0) {
    return NGN_PLACEHOLDER;
  }

  const ngn = usd * rate;
  if (!Number.isFinite(ngn)) return NGN_PLACEHOLDER;

  // Collapse -0 so a zero balance never renders as "-NGN 0.00".
  return ngnFormatter.format(ngn === 0 ? 0 : ngn);
}

export function formatUSD(usd: number): string {
  if (!Number.isFinite(usd)) return USD_PLACEHOLDER;
  return usdFormatter.format(usd === 0 ? 0 : usd);
}

const ngnWholeFormatter = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0,
});

/**
 * Formats an amount that is already in naira.
 *
 * Kobo are dropped above ₦1,000 — a share price of ₦301,845 does not gain
 * anything from two more digits, and the false precision reads as noise.
 */
export function formatNGNAmount(ngn: number | null): string {
  if (ngn === null || !Number.isFinite(ngn)) return NGN_PLACEHOLDER;
  const value = ngn === 0 ? 0 : ngn;
  return Math.abs(value) >= 1_000
    ? ngnWholeFormatter.format(value)
    : ngnFormatter.format(value);
}

const percentFormatter = new Intl.NumberFormat("en-NG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

/** Basis points as a signed percentage, e.g. `+1.23%`. */
export function formatPremiumBps(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return "—";
  return `${percentFormatter.format(bps / 100)}%`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How old a reference reading is, as a short factual phrase: `29m old`,
 * `13h old`. Null when there is no timestamp to describe.
 *
 * Every feed carries its own age — verified spread on a single afternoon was 29
 * minutes to 14h 53m — so this is per token and never inferred from a market
 * calendar. Coarse on purpose: the figure captions a price so the premium beside
 * it does not read as more precise than it is, and a ticking countdown would
 * imply urgency that isn't there. Clock skew putting a reading slightly ahead of
 * us reads as under a minute rather than a negative age.
 *
 * A null `nowMs` means the caller has no clock it can trust yet — before mount,
 * where reading `Date.now()` during render would disagree with the server pass.
 * That yields null too, so nothing is captioned rather than captioned wrongly.
 */
export function formatFeedAge(
  updatedAtMs: number | null,
  nowMs: number | null,
): string | null {
  if (updatedAtMs === null || !Number.isFinite(updatedAtMs)) return null;
  if (nowMs === null || !Number.isFinite(nowMs)) return null;

  const age = nowMs - updatedAtMs;

  if (age < MINUTE_MS) return "under a minute old";
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m old`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h old`;
  return `${Math.floor(age / DAY_MS)}d old`;
}

