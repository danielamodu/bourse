import { describe, expect, it } from "vitest";

import { walletOffer, type OfferableWallet } from "./wallet-offer";

/**
 * The connect panel's list, decided offline.
 *
 * These are the real shapes wagmi produces, written out rather than mocked: the
 * generic `injected()` connector, Coinbase's SDK connector, and the EIP-6963
 * connectors wagmi appends once a wallet announces itself. The uids are wagmi's
 * per-instance ones, so they are arbitrary strings here too.
 */

/** The generic `injected()` connector from `lib/wagmi.ts`. Name: "Injected". */
const GENERIC: OfferableWallet = {
  uid: "u-generic",
  id: "injected",
  type: "injected",
};

/** Coinbase Wallet. `id` is the SDK-flavoured one; `type` is what we match on. */
const COINBASE: OfferableWallet = {
  uid: "u-coinbase",
  id: "coinbaseWalletSDK",
  type: "coinbaseWallet",
};

/** Discovered wallets. wagmi appends these, after the configured pair. */
const METAMASK: OfferableWallet = {
  uid: "u-metamask",
  id: "io.metamask",
  type: "injected",
};

const RABBY: OfferableWallet = {
  uid: "u-rabby",
  id: "io.rabby",
  type: "injected",
};

/** The array order wagmi hands over: configured first, discovered appended. */
const ALL = [GENERIC, COINBASE, METAMASK, RABBY] as const;

const uids = (wallets: readonly OfferableWallet[]) =>
  wallets.map((wallet) => wallet.uid);

/** Every injected connector answered the probe. */
const allReady = (wallets: readonly OfferableWallet[]) =>
  new Set(
    wallets
      .filter((wallet) => wallet.type === "injected")
      .map((wallet) => wallet.uid),
  );

describe("walletOffer", () => {
  it("offers only what needs no probe before the probe has run", () => {
    // First paint. Coinbase Wallet needs nothing installed, so the panel has a way
    // forward immediately; an injected button that might not open is worse than a
    // list that grows a moment later.
    expect(uids(walletOffer(ALL, null))).toEqual(["u-coinbase"]);
  });

  it("drops an injected connector whose provider never answered", () => {
    // The empty set is a finished probe that found nothing — a browser with no
    // wallet in it, which is the case `no-wallet` covers.
    expect(uids(walletOffer([GENERIC, COINBASE], new Set()))).toEqual([
      "u-coinbase",
    ]);
  });

  it("offers the browser wallet first once it has answered", () => {
    // The rule `lib/wagmi.ts` states by ordering its connectors: the wallet someone
    // already has, then Coinbase Wallet.
    expect(
      uids(walletOffer([GENERIC, COINBASE], new Set(["u-generic"]))),
    ).toEqual(["u-generic", "u-coinbase"]);
  });

  it("offers a wallet that named itself instead of the generic entry", () => {
    // The duplicate this function exists for. Both open MetaMask; wagmi de-duplicates
    // by `rdns` and the generic connector has none, so it arrives twice from wagmi
    // and must not arrive twice on screen.
    const offer = walletOffer([GENERIC, COINBASE, METAMASK], allReady(ALL));

    expect(uids(offer)).toEqual(["u-metamask", "u-coinbase"]);
    expect(uids(offer)).not.toContain("u-generic");
  });

  it("offers every wallet that named itself, in the order they arrived", () => {
    // Two extensions installed. Neither is the generic entry, so neither is dropped,
    // and nothing here reorders them against each other — wagmi's discovery order is
    // as good a guess as any and inventing a preference between two real wallets is
    // not this function's business.
    const offer = walletOffer(ALL, allReady(ALL));

    expect(uids(offer)).toEqual(["u-metamask", "u-rabby", "u-coinbase"]);
  });

  it("keeps a named wallet ahead of Coinbase Wallet, though wagmi appends it after", () => {
    // Why the ordering is applied here rather than inherited from the config array:
    // discovery appends, so config order alone would bury the wallet the user has.
    const offer = walletOffer([GENERIC, COINBASE, METAMASK], allReady(ALL));
    const names = uids(offer);

    expect(names.indexOf("u-metamask")).toBeLessThan(
      names.indexOf("u-coinbase"),
    );
  });

  it("keeps the generic entry when it is the only injected wallet there is", () => {
    // A wallet's in-app browser that does not implement EIP-6963 — common enough on
    // a phone. "Browser Wallet" is the label, and it is the whole offer besides
    // Coinbase Wallet.
    const offer = walletOffer([GENERIC, COINBASE], allReady(ALL));

    expect(uids(offer)).toEqual(["u-generic", "u-coinbase"]);
  });

  it("does not offer a named wallet that failed the probe", () => {
    // A discovered connector that cannot produce a provider is as dead a button as a
    // generic one, and it must not take the generic entry's place on the way out.
    const offer = walletOffer(
      [GENERIC, COINBASE, METAMASK],
      new Set(["u-generic"]),
    );

    expect(uids(offer)).toEqual(["u-generic", "u-coinbase"]);
  });

  it("returns nothing when there is nothing to offer", () => {
    // `no-wallet` in `lib/wallet-state.ts`. Unreachable while Coinbase Wallet is
    // configured, and correct the moment it is not.
    expect(walletOffer([], null)).toEqual([]);
    expect(walletOffer([GENERIC], new Set())).toEqual([]);
  });

  it("hands back the connectors it was given, not copies of them", () => {
    // `hooks/useWallet.ts` calls `connect({ connector })` with these objects, so
    // identity has to survive: a reconstructed connector would not connect.
    const offer = walletOffer(ALL, allReady(ALL));

    expect(offer[0]).toBe(METAMASK);
    expect(offer.at(-1)).toBe(COINBASE);
  });

  it("collapses repeat announcements of one wallet to the first", () => {
    // Live shape: discovery announced the same wallet three times, each with
    // its own uid, and the panel rendered three identical buttons for it.
    const repeat: OfferableWallet = {
      uid: "u-metamask-2",
      id: "io.metamask",
      type: "injected",
    };
    const offer = walletOffer(
      [GENERIC, COINBASE, METAMASK, repeat],
      allReady([GENERIC, COINBASE, METAMASK, repeat]),
    );

    expect(uids(offer)).toEqual(["u-metamask", "u-coinbase"]);
    expect(offer[0]).toBe(METAMASK);
  });

  it("does not mutate the list it was given", () => {
    const input = [...ALL];

    walletOffer(input, allReady(ALL));

    expect(input).toEqual([...ALL]);
  });
});
