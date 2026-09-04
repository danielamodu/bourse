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
 * - **`injected` before `coinbaseWallet`.** The array order is the order the panel
 *   offers them in, so the first button is "connect the wallet you already have".
 *
 * The ordering is checked twice: once against the config wagmi actually built, which
 * is the thing that ships, and once against the source text. The second is not
 * redundant — importing `lib/wagmi.ts` here reaches `wagmi/connectors`, a barrel that
 * pulls the `baseAccount` connector and through it `@x402/*`, which this repo
 * deliberately does not install (see CLAUDE.md). `next.config.ts` aliases those to
 * `false` for the build; vitest honours no such alias, so the import may simply not
 * resolve. When it does not, the text assertions still hold the line, and the run says
 * which half it got.
 *
 * No jsdom. Nothing here renders, and none of these connectors touches a window at
 * construction.
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

  it("builds a config whose connectors are in that order", async () => {
    const config = await loadConfig();

    if (config === null) {
      // Not a pass disguised as a skip: the source assertions above cover the same
      // decision, and this branch prints why the stronger check could not run.
      console.info(
        "  lib/wagmi.ts did not import here; the source assertions are what held.",
      );
      return;
    }

    const ids = config.connectors.map((connector) => connector.id);
    const types = config.connectors.map((connector) => connector.type);

    console.info(`  connectors: ${ids.join(", ")}`);

    // `type` rather than `id`, which for Coinbase's connector is the SDK-flavoured
    // `coinbaseWalletSDK` and has changed across wagmi versions. The ids are printed
    // above so a rename is visible in the output either way.
    const injectedAt = types.indexOf("injected");
    const coinbaseAt = types.indexOf("coinbaseWallet");

    expect(injectedAt, `no injected connector in ${types.join(", ")}`).toBeGreaterThan(
      -1,
    );
    expect(
      coinbaseAt,
      `no coinbaseWallet connector in ${types.join(", ")}`,
    ).toBeGreaterThan(-1);

    expect(
      injectedAt < coinbaseAt,
      `connectors are ${ids.join(", ")}; injected has to come first`,
    ).toBe(true);
  });
});

/** The built config, or null when the module cannot be imported in this runtime. */
async function loadConfig(): Promise<{
  connectors: readonly { id: string; type: string }[];
} | null> {
  try {
    const loaded = await import("./wagmi");
    return loaded.config;
  } catch (error) {
    console.info(
      `  import failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
