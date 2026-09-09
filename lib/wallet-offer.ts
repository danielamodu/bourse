/**
 * Which wallets the connect panel offers, and in what order.
 *
 * A pure function beside `lib/wallet-state.ts`, for the same reason: it is a
 * judgement, and `hooks/useWallet.ts` is meant to be an adapter that makes none.
 * Everything here is decided from a list of connectors and one set of uids, so it
 * has an offline test and no React, no wagmi and no `window`.
 *
 * Three rules, in the order they apply:
 *
 * 1. **A button has to open something.** An injected connector is offered only once
 *    it has confirmed it has a provider behind it. Anything else — Coinbase Wallet,
 *    today — needs nothing installed and is always offerable.
 * 2. **A wallet that names itself is offered once, not twice.** wagmi appends an
 *    EIP-6963-discovered connector per installed wallet, and does not de-duplicate
 *    those against the generic `injected()` connector we configure. Both open the
 *    same provider.
 * 3. **The wallet someone already has comes first.** `lib/wagmi.ts` says so by
 *    listing `injected` before `coinbaseWallet`; discovery appends to the end of the
 *    array, so the rule has to be applied rather than inherited.
 * 4. **One entry per wallet.** Discovery can announce the same wallet more than
 *    once, and each announcement arrives as a connector with its own uid —
 *    every repeat renders as another identical button for one wallet.
 */

/**
 * The part of a wagmi connector this decision reads.
 *
 * Structural, so the hook passes real connectors and gets real connectors back —
 * it needs the whole object to call `connect` with. Nothing here is wagmi-specific
 * enough to import wagmi for.
 */
export type OfferableWallet = {
  /** wagmi's per-instance id, stable for the life of the config. */
  uid: string;
  /**
   * The connector's id: `"injected"` for the generic one `lib/wagmi.ts` configures,
   * and the wallet's own `rdns` — `"io.metamask"` — for a discovered one. It is how
   * a wallet that named itself is told apart from the entry that did not.
   */
  id: string;
  /**
   * The connector kind: `"injected"` for anything reading the page's provider,
   * `"coinbaseWallet"` for the SDK. Steadier than `id`, which for Coinbase's
   * connector is the SDK-flavoured `coinbaseWalletSDK` and has been renamed before.
   */
  type: string;
};

/** wagmi's id for the connector that just takes whatever provider the page has. */
const GENERIC_INJECTED_ID = "injected";

/** The connector type that needs a provider present before it can be offered. */
const INJECTED_TYPE = "injected";

/**
 * The wallets to offer, best first. Empty means there is nothing to offer at all.
 *
 * @param connectors Every connector wagmi has, in its order: configured ones first,
 *   discovered ones appended.
 * @param injectedReady uids of the injected connectors that answered `getProvider()`.
 *   Null before that probe has run, which is the first paint — and it withholds
 *   injected entries rather than guessing at them, because a button that does nothing
 *   when tapped makes the app look broken rather than the wallet look absent.
 */
export function walletOffer<T extends OfferableWallet>(
  connectors: readonly T[],
  injectedReady: ReadonlySet<string> | null,
): readonly T[] {
  const offerable = connectors.filter(
    (connector) =>
      connector.type !== INJECTED_TYPE ||
      (injectedReady !== null && injectedReady.has(connector.uid)),
  );

  /*
   * Collapse repeat announcements before anything else counts entries. The
   * `id` is reverse-DNS per wallet app, so grouping on it cannot merge two
   * different wallets; the first announcement wins and keeps its connector
   * identity, which `hooks/useWallet.ts` needs intact to connect with.
   */
  const seenIds = new Set<string>();
  const distinct = offerable.filter((connector) => {
    if (connector.type !== INJECTED_TYPE) return true;
    if (seenIds.has(connector.id)) return false;
    seenIds.add(connector.id);
    return true;
  });

  const injected = distinct.filter(
    (connector) => connector.type === INJECTED_TYPE,
  );
  const rest = distinct.filter((connector) => connector.type !== INJECTED_TYPE);

  /*
   * A named wallet replaces the generic entry rather than joining it.
   *
   * `id === "injected"` is wagmi's own id for the generic connector. If that ever
   * changes, this keeps the generic entry and the panel gains a duplicate button,
   * which is the safe direction to be wrong in: two buttons that both work beats
   * dropping the only one that does.
   */
  const named = injected.filter(
    (connector) => connector.id !== GENERIC_INJECTED_ID,
  );

  return [...(named.length > 0 ? named : injected), ...rest];
}
