/**
 * The single seam between Bourse and whatever is quoting USD -> NGN.
 *
 * Nothing outside this file may know where the rate comes from. Consumers
 * import `rateSource` (typed as `RateSource`) and get a number. Swapping the
 * provider later — e.g. a live onramp quote instead of a reference rate —
 * means adding another `RateSource` implementation here and re-pointing the
 * `rateSource` export. No hook, component or caller changes.
 */

/** Wire shape of `GET /api/ngn-rate`. */
export type NgnRatePayload = {
  rate: number;
  fetchedAt: number;
  source: string;
};

export interface RateSource {
  getUsdToNgn(): Promise<{ rate: number; fetchedAt: number }>;
}

export class RateSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RateSourceError";
  }
}

const DEFAULT_ENDPOINT = "/api/ngn-rate";
const DEFAULT_TIMEOUT_MS = 10_000;

export type ExchangeRateApiSourceOptions = {
  /** Absolute URL required when calling from the server; relative is fine in the browser. */
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Reads the rate from our own route, which proxies open.er-api.com.
 * The upstream is never called from the browser.
 */
export class ExchangeRateApiSource implements RateSource {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ExchangeRateApiSourceOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl =
      options.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));
  }

  async getUsdToNgn(): Promise<{ rate: number; fetchedAt: number }> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (cause) {
      throw new RateSourceError("Could not reach the NGN rate service", { cause });
    }

    if (!response.ok) {
      throw new RateSourceError(
        `NGN rate service responded with ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new RateSourceError("NGN rate service returned malformed JSON", {
        cause,
      });
    }

    return parseRate(body);
  }
}

/**
 * Validates an untrusted payload into a usable rate. A rate of zero, a
 * negative, or a non-number is rejected rather than passed on — showing a
 * naira figure derived from a bad rate is worse than showing nothing.
 */
export function parseRate(body: unknown): { rate: number; fetchedAt: number } {
  if (typeof body !== "object" || body === null) {
    throw new RateSourceError("NGN rate payload was not an object");
  }

  const { rate, fetchedAt } = body as Partial<NgnRatePayload>;

  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new RateSourceError(`NGN rate payload had an unusable rate: ${rate}`);
  }

  return {
    rate,
    fetchedAt:
      typeof fetchedAt === "number" && Number.isFinite(fetchedAt) && fetchedAt > 0
        ? fetchedAt
        : Date.now(),
  };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** The provider the rest of the app uses. Repoint this to swap providers. */
export const rateSource: RateSource = new ExchangeRateApiSource();
