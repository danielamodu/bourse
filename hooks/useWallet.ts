"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { erc20Abi } from "viem";
import {
  useAccount,
  useBalance,
  useConnect,
  useConnectors,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from "wagmi";

import { BASE_CHAIN_ID } from "@/lib/rpc";
import { USDC_ADDRESS } from "@/lib/tokens";
import { walletOffer } from "@/lib/wallet-offer";
import {
  isUserRejection,
  walletState,
  type ConnectionPhase,
  type WalletState,
} from "@/lib/wallet-state";

/**
 * wagmi, reduced to the one question the connect panel asks.
 *
 * Every judgement lives in a pure function with no React in it and an offline test:
 * `lib/wallet-state.ts` decides what the panel says, `lib/wallet-offer.ts` decides
 * which wallets it offers and in what order. This file is only the adapter — read
 * wagmi's hooks, assemble the inputs, hand back the answers and the actions a user
 * can take.
 *
 * `window.ethereum` is never mentioned, and that is structural rather than stylistic.
 * Availability, the account, the chain and both balances all come through wagmi, so
 * an embedded or passkey wallet is a new entry in `lib/wagmi.ts` rather than a new
 * branch in this file.
 *
 * Still reads only. The wallet is connected here so balances can be read and a state
 * reported; `hooks/useTrade.ts` is the one place that asks for a signature, and it
 * takes this hook's `state` as its gate rather than reading wagmi again.
 */

export type UseWalletInput = {
  /**
   * The current quote's estimated fee in wei, from `Quote.gasWei`. Null with no
   * quote on screen, which switches the low-ETH warning off.
   *
   * The whole reason the hook takes an argument at all. The warning compares a fee
   * against a balance, so it needs the fee, and the fee belongs to the quote rather
   * than to the wallet.
   */
  gasWei?: bigint | null;
};

export type UseWalletResult = {
  /** What to render. The whole of the decision, from `lib/wallet-state.ts`. */
  state: WalletState;
  /** The connected address, for display. Null when there is no connection. */
  address: string | null;
  /**
   * The wallets to offer, in offer order — the wallet someone already has first,
   * Coinbase Wallet second, which is the preference `lib/wagmi.ts` states.
   *
   * Only connectors that can actually open are in here, and a wallet that reports
   * its own name appears once rather than twice. Empty means there is genuinely
   * nothing to offer, which is the `no-wallet` state.
   */
  connectors: readonly WalletOption[];
  /**
   * A connection that failed for a reason worth saying out loud.
   *
   * False after a rejection, deliberately. Dismissing a wallet prompt is a choice,
   * not a fault, and a banner in response to it reads as an accusation. A failure
   * that is *not* a rejection has to be said, or the button looks broken.
   */
  connectFailed: boolean;
  /** A network switch the wallet would not make. Same rule about rejections. */
  switchFailed: boolean;
  /** True while a switch is in flight, so the control can say so. */
  switching: boolean;
  /** Open one of `connectors`, by uid. An unknown uid does nothing. */
  connect: (uid: string) => void;
  disconnect: () => void;
  switchToBase: () => void;
  /** Read both balances again — for after someone tops up and comes back. */
  refetchBalances: () => void;
};

/** One offerable wallet, reduced to what a button needs. */
export type WalletOption = {
  /** wagmi's per-instance id, stable for the life of the config. */
  uid: string;
  /** The connector's own name, unformatted — `formatConnectorName` is the view's. */
  name: string;
};

/** The connector type this config produces, taken from wagmi rather than restated. */
type WalletConnector = ReturnType<typeof useConnectors>[number];

export function useWallet({ gasWei = null }: UseWalletInput = {}): UseWalletResult {
  const { address, chainId, status } = useAccount();
  const connectors = useConnectors();
  const {
    connect,
    error: connectError,
    isPending: connectPending,
    reset: resetConnect,
  } = useConnect();
  const { disconnect } = useDisconnect();
  const {
    switchChain,
    error: switchError,
    isPending: switching,
  } = useSwitchChain();

  const offered = useOfferableConnectors(connectors);

  /*
   * Both reads are aimed at Base explicitly and only run once there is an account.
   *
   * They go through the config's own transport rather than the wallet's, so a wallet
   * sitting on Ethereum would still return a Base figure here. That is not a problem
   * because the state machine puts the chain check ahead of balances — but it is the
   * reason the chain id is passed rather than inferred.
   */
  const enabled = status === "connected" && address !== undefined;

  const eth = useBalance({
    address,
    chainId: BASE_CHAIN_ID,
    query: { enabled },
  });

  const usdc = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : ([address] as const),
    chainId: BASE_CHAIN_ID,
    query: { enabled },
  });

  /*
   * `isPending` covers a window wagmi's own status does not.
   *
   * `useConnect` flips to pending the moment the request goes out, while
   * `useAccount().status` stays `disconnected` until the wallet answers. Without
   * this, tapping connect would render "not connected" for as long as the prompt is
   * open — which is exactly when someone is deciding whether to trust us.
   */
  const phase: ConnectionPhase =
    status === "connected"
      ? "connected"
      : connectPending
        ? "connecting"
        : status;

  const state = walletState({
    hasConnector: offered.length > 0,
    phase,
    chainId: chainId ?? null,
    ethWei: eth.data?.value ?? null,
    usdcUnits: usdc.data ?? null,
    balancesFailed: eth.isError || usdc.isError,
    /*
     * Wei against wei, so the warning actually fires.
     *
     * It used to be a pair of USD figures, and there is no verified ETH/USD source
     * in this repo to fill them with — so it was permanently off for the person it
     * was written for: someone who bought USDC on an exchange, withdrew it to Base,
     * and holds no ETH to pay a fee with. `gas * gasPrice` off the route summary
     * needs no price for anything.
     */
    gasWei,
  });

  const connectWallet = useCallback(
    (uid: string) => {
      const connector = offered.find((candidate) => candidate.uid === uid);
      // A uid that is not on offer is a stale button from a previous render, not
      // something to guess at: connecting to a different wallet than the one that
      // was tapped is the last thing this screen should do.
      if (connector === undefined) return;
      // Clear the last attempt first, or a stale failure explains a fresh try.
      resetConnect();
      connect({ connector });
    },
    [connect, offered, resetConnect],
  );

  // Wrapped rather than passed through: wagmi's mutations take variables as their
  // first argument, and an onClick handler would hand them a click event.
  const disconnectWallet = useCallback(() => disconnect(), [disconnect]);

  const switchToBase = useCallback(
    () => switchChain({ chainId: BASE_CHAIN_ID }),
    [switchChain],
  );

  // The query objects change identity every render; their `refetch` does not.
  const refetchEth = eth.refetch;
  const refetchUsdc = usdc.refetch;

  const refetchBalances = useCallback(() => {
    void refetchEth();
    void refetchUsdc();
  }, [refetchEth, refetchUsdc]);

  /*
   * Reduced to `{ uid, name }` here rather than in the component.
   *
   * The panel gets no `connect()` methods and no provider handles — it renders a
   * label and hands a uid back. Memoised on the connector list so the array does
   * not change identity on every render of the trade page.
   */
  const options = useMemo<readonly WalletOption[]>(
    () =>
      offered.map((connector) => ({
        uid: connector.uid,
        name: connector.name,
      })),
    [offered],
  );

  return {
    state,
    address: address ?? null,
    connectors: options,
    connectFailed: connectError !== null && !isUserRejection(connectError),
    switchFailed: switchError !== null && !isUserRejection(switchError),
    switching,
    connect: connectWallet,
    disconnect: disconnectWallet,
    switchToBase,
    refetchBalances,
  };
}

/**
 * The wallets to offer: probed for availability here, ordered by `lib/wallet-offer.ts`.
 *
 * Availability is the only thing this hook decides, and it asks the connector rather
 * than the window. `getProvider()` is wagmi's own question, and only injected
 * connectors are asked it: Coinbase's SDK has no host provider to find, and
 * instantiating it on first paint to prove that would be work for an answer we
 * already have. Every button on this panel has to open something — one that does
 * nothing when tapped makes the app look broken rather than the wallet look absent —
 * so an injected entry with no wallet behind it is dropped rather than disabled.
 *
 * Which of the answers become buttons, and in what order, is `walletOffer`'s call,
 * with an offline test. `no-wallet` stays a state the machine covers rather than a
 * screen people reach, because Coinbase Wallet is always offerable — and it is kept
 * regardless: it is correct the moment that stops being true, and it costs one branch.
 */
function useOfferableConnectors(
  connectors: readonly WalletConnector[],
): readonly WalletConnector[] {
  /** uids of injected connectors that answered. Null until the probe has run. */
  const [injectedReady, setInjectedReady] = useState<ReadonlySet<string> | null>(
    null,
  );

  /*
   * Keyed on the uids rather than the array.
   *
   * The effect sets state, which re-renders, which can hand back a fresh array
   * identity — and an effect that depends on the array would then run again, set
   * state again, and loop. The uid list is the part that actually changes when the
   * config's connectors change.
   */
  const key = connectors.map((connector) => connector.uid).join(" ");

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const found = await Promise.all(
        connectors
          .filter((connector) => connector.type === "injected")
          .map(async (connector) => {
            try {
              return (await connector.getProvider()) ? connector.uid : null;
            } catch {
              // A connector that cannot say whether it has a provider has not got one.
              return null;
            }
          }),
      );

      if (cancelled) return;

      setInjectedReady(
        new Set(found.filter((uid): uid is string => uid !== null)),
      );
    })();

    return () => {
      cancelled = true;
    };
    // `connectors` is read inside, but `key` is what identifies a real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return useMemo(
    () => walletOffer(connectors, injectedReady),
    [connectors, injectedReady],
  );
}
