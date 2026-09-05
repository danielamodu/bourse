import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The two connector decisions in `lib/wagmi.ts`, pinned so they cannot be tidied
 * away.
 *
 * Both look like preferences and are not:
 *
 * - **`preference: "all"`, never `"smartWalletOnly"`.** `"smartWalletOnly"` refuses
 *   an existing Coinbase Wallet and offers only a fresh passkey Smart Wallet, which
 *   is an empty account. Everyone who can buy here already holds USDC somewhere, so
 *   that path ends in a wallet with nothing in it and no route to the money.
 * - **`injected` before `coinbaseWallet`.** It is the preference the panel starts
 *   from, so the first button is "connect the wallet you already have".
 *
 * Both are read from the source text, and this file deliberately does not import
 * `lib/wagmi.ts`. That import reaches `wagmi/connectors`, a barrel that pulls the
 * `baseAccount` connector and through it `@x402/*`, which this repo does not install
 * (see CLAUDE.md): `next.config.ts` aliases those away for the build, and vitest
 * honours no such alias. Resolving it took longer than the 5s timeout, and it would
 * cost that on every `npm test` — coupling the fastest suite in the repo to the most
 * fragile corner of the webpack graph. Do not reintroduce it with a longer timeout.
 *
 * Config order is also not what a user ends up seeing. wagmi appends
 * EIP-6963-discovered connectors after the configured ones, so the order on screen is
 * `walletOffer`'s doing and `lib/wallet-offer.test.ts` covers that in eleven cases.
 * What is left for this file is the config array itself, which is a line of source.
 *
 * No jsdom, no network, and nothing imported but `node:fs`.
 */

/** The file itself. `import.meta.url` rather than `__dirname`, which ESM has not got. */
const SOURCE = readFileSync(new URL("./wagmi.ts", import.meta.url), "utf8");

/**
 * The source with its comments removed.
 *
 * `lib/wagmi.ts` names `smartWalletOnly` in prose, to say why it is not used — a
 * test that forbade the word outright would force that explanation out of the file,
 * which is the opposite of pinning a decision. So the word is forbidden in code and
 * welcome in a comment.
 *
 * The line-comment pattern will not match a `//` preceded by a colon, quote or
 * backslash, so the RPC URL in that file survives being read as a comment.
 */
function stripComments(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const CODE = stripComments(SOURCE);

/** Where a connector is *called*, which is never where it is imported. */
function callIndex(code: string, connector: string): number {
  return code.indexOf(`${connector}(`);
}

describe("the coinbaseWallet preference", () => {
  it("is all, so an existing Coinbase Wallet can connect", () => {
    // Read as a value rather than searched for as a word: this is the line that
    // decides behaviour, and it is the only `preference` in the file.
    const preferences = [...CODE.matchAll(/preference\s*:\s*"([^"]*)"/g)].map(
      (match) => match[1],
    );

    expect(preferences, "one preference, on the coinbaseWallet connector").toEqual([
      "all",
    ]);
  });

  it("is not smartWalletOnly anywhere in the code", () => {
    // The regression this file exists for. `"smartWalletOnly"` reads like the
    // tidier, more opinionated choice, which is exactly why it needs an assertion
    // rather than a comment.
    expect(
      CODE,
      "smartWalletOnly is back in lib/wagmi.ts. It offers a fresh, empty Smart Wallet and refuses the wallet the user already funded — read the comment above the connector before changing this.",
    ).not.toMatch(/smartWalletOnly/);
  });
});

describe("the connector order", () => {
  it("lists injected before coinbaseWallet in the source", () => {
    const injectedAt = callIndex(CODE, "injected");
    const coinbaseAt = callIndex(CODE, "coinbaseWallet");

    expect(injectedAt, "injected() is not called in lib/wagmi.ts").toBeGreaterThan(
      -1,
    );
    expect(
      coinbaseAt,
      "coinbaseWallet() is not called in lib/wagmi.ts",
    ).toBeGreaterThan(-1);

    expect(
      injectedAt < coinbaseAt,
      "coinbaseWallet is offered before injected. The first button on the wallet panel should be the wallet the user already has.",
    ).toBe(true);
  });

  it("keeps shimDisconnect on the injected connector", () => {
    // Without it, a disconnect is forgotten on reload and the panel reconnects to a
    // wallet the user deliberately closed.
    expect(CODE).toMatch(/injected\(\s*\{\s*shimDisconnect:\s*true\s*\}\s*\)/);
  });
});
