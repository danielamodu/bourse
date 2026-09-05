import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BASE_RPC_URLS,
  baseRpcUrls,
  dedicatedRpcUrl,
  rotatedRpcUrls,
} from "@/lib/rpc";

/**
 * The endpoint rotation, and the variable name that keeps a provider key out of the
 * browser.
 *
 * No network in any of it: three functions over `process.env` and array order. What
 * is worth pinning is that `BASE_RPC_URL` leads when it is set, that the public
 * three sit behind it rather than being replaced by it, and that unset, empty and
 * whitespace all degrade to the public list rather than pointing viem at "".
 *
 * `rotation` is module state, so nothing here asserts a sequence. The property is
 * that consecutive calls lead with different public endpoints, and that holds from
 * any starting offset — a test written around offset zero would pass or fail on the
 * order vitest happened to load files in.
 */

/** Named rather than inlined: the name is the safety property being tested. */
const VARIABLE = "BASE_RPC_URL";

/** Shaped like a provider URL with a key in it, which is the case that matters. */
const DEDICATED = "https://base-mainnet.example.com/v2/a-key";

let original: string | undefined;

/*
 * Saved and restored around every case. Vitest reuses a worker across files, so a
 * variable left set here would be read by whichever suite ran next in it — and a
 * developer with a real BASE_RPC_URL in their environment must not get a different
 * result from this file than CI does.
 */
beforeEach(() => {
  original = process.env[VARIABLE];
  delete process.env[VARIABLE];
});

afterEach(() => {
  if (original === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = original;
});

describe("dedicatedRpcUrl", () => {
  it("is null when nothing is configured", () => {
    expect(dedicatedRpcUrl()).toBeNull();
  });

  it("reads empty and whitespace as nothing configured", () => {
    // `.env.example` ships `BASE_RPC_URL=`, so a variable created and never filled
    // in is the ordinary state of a fresh clone rather than an odd one. Returning ""
    // would hand viem an empty URL and break reads that worked before it existed.
    for (const value of ["", " ", "\t", "\n  "]) {
      process.env[VARIABLE] = value;

      expect(dedicatedRpcUrl(), JSON.stringify(value)).toBeNull();
    }
  });

  it("trims the value, so a trailing newline never reaches viem", () => {
    process.env[VARIABLE] = `  ${DEDICATED}\n`;

    expect(dedicatedRpcUrl()).toBe(DEDICATED);
  });

  it("reads BASE_RPC_URL and never a NEXT_PUBLIC_ copy of it", () => {
    // The variable name is the whole of the protection. A NEXT_PUBLIC_ one is
    // inlined into the JavaScript every visitor downloads, key and all, so this must
    // not fall back to one however tidy the symmetry would look.
    process.env["NEXT_PUBLIC_BASE_RPC_URL"] = DEDICATED;

    try {
      expect(dedicatedRpcUrl()).toBeNull();
    } finally {
      delete process.env["NEXT_PUBLIC_BASE_RPC_URL"];
    }
  });
});

describe("baseRpcUrls", () => {
  it("is exactly the public list when there is no dedicated endpoint", () => {
    // The degrade-rather-than-break case: with the variable absent, everything
    // behaves as it did before it existed.
    expect(baseRpcUrls()).toEqual([...BASE_RPC_URLS]);
  });

  it("leads with the dedicated endpoint and keeps all three behind it", () => {
    // Behind it, not instead of it. A dedicated endpoint is one provider having an
    // outage away from being the only endpoint, and the public three are what answer
    // when it does.
    process.env[VARIABLE] = DEDICATED;

    expect(baseRpcUrls()).toEqual([DEDICATED, ...BASE_RPC_URLS]);
  });

  it("hands back a copy, so a caller cannot edit the module's own list", () => {
    const urls = baseRpcUrls();
    urls.push("https://not-base.example.com");

    expect(baseRpcUrls()).toEqual([...BASE_RPC_URLS]);
  });
});

describe("rotatedRpcUrls", () => {
  it("carries every public endpoint on every call", () => {
    // The fallback transport walks this list in order, so an endpoint missing from it
    // is an endpoint that cannot be fallen back to.
    expect(new Set(rotatedRpcUrls())).toEqual(new Set(BASE_RPC_URLS));
  });

  it("gives the lead to a different public endpoint each time", () => {
    // The point of rotating at all: `mainnet.base.org` rate-limits after roughly a
    // dozen calls, so it must not be the first choice on all of them.
    const leads = BASE_RPC_URLS.map(() => rotatedRpcUrls()[0]);

    expect(new Set(leads)).toEqual(new Set(BASE_RPC_URLS));
  });

  it("always leads with the dedicated endpoint when there is one", () => {
    // Rotation is for spreading load across free endpoints. The dedicated one is the
    // one with headroom, so it does not take turns — it goes first every call, and
    // the rotation continues underneath it.
    process.env[VARIABLE] = DEDICATED;

    for (let call = 0; call <= BASE_RPC_URLS.length; call += 1) {
      const urls = rotatedRpcUrls();

      expect(urls[0], `call ${call}`).toBe(DEDICATED);
      expect(new Set(urls.slice(1)), `call ${call}`).toEqual(
        new Set(BASE_RPC_URLS),
      );
    }
  });
});

describe("BASE_RPC_URLS", () => {
  it("is three distinct https endpoints", () => {
    // Three because the rotation divides by the length of this list, and https
    // because a plaintext RPC URL leaks every address it is asked about.
    expect(BASE_RPC_URLS).toHaveLength(3);
    expect(new Set(BASE_RPC_URLS).size).toBe(3);

    for (const url of BASE_RPC_URLS) {
      expect(url, url).toMatch(/^https:\/\//);
    }
  });
});
