"use client";

import type { UseWalletResult } from "@/hooks/useWallet";
import { cx } from "@/lib/cx";
import {
  formatAddressShort,
  formatChainName,
  formatConnectorName,
} from "@/lib/format";
import type { WalletState } from "@/lib/wallet-state";

import styles from "./WalletConnect.module.css";

/**
 * The wallet surface, gating at the moment of action rather than before it.
 *
 * This sits under the trade panel, so the whole market — price, quote, spread, fee,
 * total — is readable with no wallet connected and no wallet code involved in the
 * `/markets` bundle. Connecting is what someone does *after* deciding the price is
 * worth paying, and this is the first thing on the page that asks for anything.
 *
 * Presentational. Which of the nine situations applies is decided in
 * `lib/wallet-state.ts` and adapted from wagmi in `hooks/useWallet.ts`; this file
 * holds the sentences and the controls each one gets.
 *
 * Two rules shape the copy. Every state names one next action and no more, and no
 * state implies fault: a wallet on the wrong network, an empty balance and a
 * dismissed prompt are all ordinary things that happen to people who are being
 * careful. A declined connection renders no banner at all — it returns to the same
 * offer it started from.
 *
 * The one state that offers more than a single control is `disconnected`, and what
 * it offers is a choice of wallet rather than a choice of action: every button there
 * does the same thing. `hooks/useWallet.ts` puts them in order, so the first is the
 * wallet someone already has.
 *
 * IT DOES NOT CALL `useWallet` ITSELF, and that is not tidiness. The trade panel beside
 * it needs the same wallet state — `useTrade` treats anything but `ready` as a block —
 * and two calls to the hook would mean two independent sets of balance reads against a
 * rate-limited RPC, which could disagree with each other on screen. One call in
 * `TradeDetail` feeds both, so the wallet the panel gates on is the wallet this
 * describes.
 *
 * Connecting still signs nothing and spends nothing. The signatures live in the trade
 * panel's own button, and every control here reads a balance or changes a network.
 */

export type WalletConnectProps = {
  /** One `useWallet()` call, made by the page and shared with the trade panel. */
  wallet: UseWalletResult;
};

export function WalletConnect({ wallet }: WalletConnectProps) {
  const {
    state,
    address,
    connectors,
    connectFailed,
    switchFailed,
    switching,
    connect,
    disconnect,
    switchToBase,
    refetchBalances,
  } = wallet;

  return (
    <section className={styles.panel} aria-labelledby="wallet-title">
      <h2 id="wallet-title" className={styles.title}>
        {headline(state)}
      </h2>

      <p className={styles.body} aria-live="polite">
        {explain(state, address)}
      </p>

      {state.kind === "ready" && state.lowEth ? (
        <p className={cx(styles.body, styles.notice)}>
          Your ETH is worth less than the network fee this quote estimates. A little
          more would make the trade safe to send.
        </p>
      ) : null}

      {/* One button per wallet we can actually open, in offer order. The first is
          styled as the primary action because it is the likeliest one — the wallet
          already installed in this browser — not because the others are lesser
          choices. Every entry here connects; none of them signs or spends. */}
      {state.kind === "disconnected" ? (
        <ul className={styles.choices}>
          {connectors.map((connector, index) => {
            const label = formatConnectorName(connector.name);

            return (
              <li key={connector.uid}>
                <button
                  type="button"
                  className={index === 0 ? styles.primary : styles.quiet}
                  aria-label={`Connect ${label}`}
                  onClick={() => connect(connector.uid)}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {state.kind === "wrong-chain" ? (
        <button
          type="button"
          className={styles.primary}
          onClick={switchToBase}
          disabled={switching}
        >
          {switching ? "Switching…" : "Switch to Base"}
        </button>
      ) : null}

      {state.kind === "balances-unreadable" ||
      state.kind === "no-eth" ||
      state.kind === "no-usdc" ? (
        <button type="button" className={styles.quiet} onClick={refetchBalances}>
          Check again
        </button>
      ) : null}

      {state.kind === "ready" ? (
        <button type="button" className={styles.quiet} onClick={disconnect}>
          Disconnect
        </button>
      ) : null}

      {/* A rejected connection never reaches either of these — `useWallet` reports a
          dismissed prompt as no failure at all, so declining returns quietly to the
          same offer. What is left is the case where the wallet never opened, which
          has to be said or the button reads as dead. */}
      {connectFailed ? (
        <p className={cx(styles.body, styles.notice)}>
          We could not open your wallet. Try again.
        </p>
      ) : null}

      {switchFailed ? (
        <p className={cx(styles.body, styles.notice)}>
          Your wallet did not switch. Change its network to Base yourself, then come
          back to this page.
        </p>
      ) : null}
    </section>
  );
}

/** One heading per state. Exhaustive, so a new state cannot ship without words. */
function headline(state: WalletState): string {
  switch (state.kind) {
    case "no-wallet":
      return "You'll need a wallet";
    case "disconnected":
      return "Connect a wallet";
    case "connecting":
      return "Waiting for your wallet";
    case "wrong-chain":
      return "Your wallet is on the wrong network";
    case "balances-unreadable":
      return "We could not read your balances";
    case "checking":
      return "Checking your balances";
    case "no-eth":
      return "You need a little ETH on Base";
    case "no-usdc":
      return "Nothing to spend yet";
    case "ready":
      return "Wallet connected";
  }
}

/**
 * One paragraph per state, and every one of them names a single next step.
 *
 * The two funding states say different things because they are different problems:
 * ETH pays the network and costs cents, USDC is the money being spent. Telling
 * someone to "add funds" would leave them guessing which, and a wallet with ₦50,000
 * of USDC and no ETH still cannot trade.
 */
function explain(state: WalletState, address: string | null): string {
  switch (state.kind) {
    case "no-wallet":
      // No control is rendered for this state. A connect button with nothing to
      // connect to is the worst version of this screen: it gets tapped, nothing
      // happens, and the app looks broken rather than the wallet looking absent.
      return (
        "A wallet holds your money and your shares, and only you can move them. " +
        "Open Bourse inside your wallet's own browser, or use a browser that has " +
        "one installed."
      );
    case "disconnected":
      return "Connecting lets us read your balances. It signs nothing and spends nothing.";
    case "connecting":
      return "Approve the connection in your wallet. Nothing is spent by approving it.";
    case "wrong-chain":
      return (
        `Your wallet is on ${formatChainName(state.chainId)}. Bourse trades on ` +
        "Base, where both the shares and the money you spend on them live."
      );
    case "balances-unreadable":
      return (
        "The network did not answer. Your wallet is fine and nothing has been " +
        "spent — this is worth another try in a moment."
      );
    case "checking":
      return "Reading what this wallet holds on Base.";
    case "no-eth":
      return (
        "Base charges a network fee of a few cents on every trade, paid in ETH, " +
        "and this wallet has none. Most exchanges can send ETH straight to Base — " +
        "choose Base as the network when you withdraw."
      );
    case "no-usdc":
      return (
        "This wallet has enough ETH for network fees, but the money that buys " +
        "shares is USDC and there is none here yet. Add some and check again."
      );
    case "ready":
      return `Connected as ${formatAddressShort(address)}, on Base, with enough for network fees.`;
  }
}
