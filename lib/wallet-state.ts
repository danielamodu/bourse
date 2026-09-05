import { BASE_CHAIN_ID } from "@/lib/rpc";

/**
 * What the wallet surface should say, as a pure function of what wagmi knows.
 *
 * Extracted from the component on purpose. This is the whole of the logic — nine
 * situations that each need different words and a different next action — and it
 * needs no React, no provider tree and no browser to test. A rendered harness
 * would test wagmi's hooks; this tests the decision.
 *
 * Nothing here touches `window.ethereum`. The component feeds it wagmi's own
 * answers, so an embedded or passkey wallet is a new connector rather than a new
 * branch, and none of the reasoning below has to change to support one.
 *
 * It decides what to show, never what to send. `hooks/useTrade.ts` is what signs,
 * and it treats anything but `ready` here as a block — which is why a state on this
 * union going wrong is a state that could let a signature be asked for too early.
 */

/** wagmi's `useAccount().status`, narrowed to the shape this module reasons about. */
export type ConnectionPhase =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected";

export type WalletInput = {
  /**
   * Whether there is any connector to offer.
   *
   * False must never render a button. A connect button that cannot connect is the
   * worst version of this screen: the user taps it, nothing happens, and they
   * conclude the app is broken rather than that they need a wallet.
   */
  hasConnector: boolean;
  phase: ConnectionPhase;
  /** The chain the wallet is on. Null when not connected or not yet known. */
  chainId: number | null;
  /** Native ETH balance in wei. Null until the read lands. */
  ethWei: bigint | null;
  /** USDC balance in base units (6 decimals). Null until the read lands. */
  usdcUnits: bigint | null;
  /**
   * Whether a balance read came back an error rather than a value.
   *
   * Without this, a failed read is indistinguishable from a pending one — both are
   * `null` — and the panel says "checking your balances" forever. Base's public RPC
   * rate-limits, and Nigerian mobile data drops requests, so this is the ordinary
   * case rather than the exotic one.
   */
  balancesFailed: boolean;
  /**
   * The current quote's estimated network fee in wei. Null with no quote, or when
   * the route carried no usable gas figure.
   *
   * Wei rather than dollars, and that is the whole of the fix: this used to be a USD
   * pair that nothing could ever fill, because Bourse has no ETH price source, so
   * the warning was permanently off. `Quote.gasWei` is `gas * gasPrice` off the
   * route summary, which compares directly against {@link WalletInput.ethWei}
   * without a price for anything.
   */
  gasWei: bigint | null;
};

export type WalletState =
  /** Nothing to connect with. Explain, offer no control. */
  | { kind: "no-wallet" }
  /** A wallet is available and not connected. The one action is connecting. */
  | { kind: "disconnected" }
  /** A connection is in flight, including wagmi's silent reconnect on load. */
  | { kind: "connecting" }
  /** Connected, wrong network. `chainId` is carried so the copy can name it. */
  | { kind: "wrong-chain"; chainId: number | null }
  /** Connected on Base, a balance read failed. Retryable, and says so. */
  | { kind: "balances-unreadable" }
  /** Connected on Base, balances not read yet. Neither zero nor funded. */
  | { kind: "checking" }
  /** No ETH at all, so no transaction can be paid for. Blocking. */
  | { kind: "no-eth" }
  /** ETH but no USDC, so there is nothing to spend. Blocking. */
  | { kind: "no-usdc" }
  /**
   * Funded and on Base. `lowEth` is a warning, never a block — there is not much
   * more ETH here than one transaction's fee, and a buy is two of them.
   */
  | { kind: "ready"; lowEth: boolean };

/**
 * The one rule that decides which of the nine the user sees.
 *
 * ORDER IS THE DESIGN. Each check assumes the ones above it passed, and moving any
 * of them would produce a confident sentence about something not yet known:
 *
 * 1. `connecting` first, so a wallet mid-handshake is never described as absent.
 *    A `connecting` phase with no connector is contradictory input, and a step
 *    label is still the safer thing to render than a dead button.
 * 2. Then availability, because "no wallet" and "not connected" differ in whether
 *    there is anything to tap.
 * 3. Chain before balances. A balance read on the wrong chain is a balance on
 *    another network, and reporting zero USDC to someone holding plenty on
 *    Ethereum would be false and would hide the real problem.
 * 4. A failed read before a pending one. Both are `null`, and the difference is
 *    whether waiting will help: `checking` promises an answer is coming, so
 *    rendering it after an error is an indefinite wait with no way out.
 * 5. `checking` before either zero. A pending read is `null`, and treating null as
 *    zero would tell a funded user to go and buy ETH.
 * 6. ETH before USDC. With no ETH nothing can be paid for at all, so it is the
 *    first thing to fix regardless of what else is missing.
 *
 * THE ETH THRESHOLD is deliberately asymmetric. Only a genuinely zero balance
 * blocks; anything above zero is `ready`. Measured gas on these routes is three to
 * five cents, so a wallet with any ETH in it almost certainly has enough, and a
 * threshold set higher would refuse trades that would have gone through. Thin
 * against the quote's own estimate it warns instead — see {@link isLowEth}.
 */
export function walletState({
  hasConnector,
  phase,
  chainId,
  ethWei,
  usdcUnits,
  balancesFailed,
  gasWei,
}: WalletInput): WalletState {
  if (phase === "connecting" || phase === "reconnecting") {
    return { kind: "connecting" };
  }

  if (phase !== "connected") {
    // Also where a rejected connection lands. wagmi returns the account to
    // `disconnected` when someone dismisses their wallet's prompt, and that is
    // not an error — they chose not to. The component renders this state plainly,
    // with no banner, so declining costs nothing to recover from.
    return hasConnector ? { kind: "disconnected" } : { kind: "no-wallet" };
  }

  if (chainId !== BASE_CHAIN_ID) {
    return { kind: "wrong-chain", chainId };
  }

  // A failure only matters for a figure we do not otherwise have. One read erroring
  // while the other succeeded still leaves us unable to answer, but a *stale* value
  // that is present is better than a dead end, so the null test is what decides.
  if (balancesFailed && (ethWei === null || usdcUnits === null)) {
    return { kind: "balances-unreadable" };
  }

  if (ethWei === null || usdcUnits === null) {
    return { kind: "checking" };
  }

  // `<= 0n` rather than `=== 0n`: a chain read cannot return a negative balance,
  // and this way a stubbed or malformed one cannot slip past as funded.
  if (ethWei <= 0n) return { kind: "no-eth" };
  if (usdcUnits <= 0n) return { kind: "no-usdc" };

  return { kind: "ready", lowEth: isLowEth(ethWei, gasWei) };
}

/**
 * How many transactions' worth of gas a wallet should hold before we stop warning.
 *
 * Two, because a buy is two transactions: an approval and a swap. A wallet holding
 * exactly one fee's worth gets through the approval and then fails at the second
 * signature, which is the worst place to run out — the allowance is set, the gas is
 * spent, and nothing was bought.
 *
 * It is a floor with margin rather than a precise figure. Base fees move with L1
 * calldata prices and can rise between the two signatures, and the estimate itself
 * is the aggregator's.
 */
export const GAS_HEADROOM = 2n;

/**
 * Whether the ETH balance is thin against what this quote's two transactions cost.
 *
 * A warning, not a gate: {@link walletState} only blocks on a genuinely zero
 * balance. Both sides are wei, so no ETH price is involved and the comparison holds
 * in the case that matters — someone who bought USDC on an exchange, withdrew it to
 * Base and has never held any ETH. Before this was in wei it compared two USD
 * figures that nothing in the app could supply, so it never fired at all.
 *
 * No quote, or no usable gas figure on the route, is no warning: null and
 * non-positive both mean there is nothing to compare, and a warning we cannot
 * substantiate would tell people to add ETH they may already have plenty of.
 */
function isLowEth(ethWei: bigint, gasWei: bigint | null): boolean {
  if (gasWei === null || gasWei <= 0n) return false;

  return ethWei < gasWei * GAS_HEADROOM;
}

/** EIP-1193's rejection code, and the string some injected wallets send instead. */
const REJECTION_CODES: ReadonlySet<unknown> = new Set([4001, "ACTION_REJECTED"]);

/** How far down a `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Whether a failed connection was the user declining it.
 *
 * This is the difference between silence and a sentence. Dismissing a wallet prompt
 * is a choice, and an error banner after it reads as an accusation; failing to open
 * the wallet at all is our problem and needs saying, or the button looks dead.
 *
 * Duck-typed on purpose, rather than `instanceof viem.UserRejectedRequestError`.
 * The error crosses two libraries and an injected provider we do not control, and
 * arrives variously as viem's class, an EIP-1193 `{ code: 4001 }` object, or
 * ethers' `ACTION_REJECTED` string — sometimes wrapped several `cause` deep. A
 * shape test catches all of those and cannot be broken by viem reorganising its
 * class hierarchy. Keeping it here also means it is covered by the offline suite
 * alongside the state machine it belongs to, with no wagmi in the test.
 *
 * The depth cap is not defensive noise: a `cause` chain can be cyclic, and an
 * unbounded walk over one would hang the connect handler.
 */
export function isUserRejection(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;

    const { name, code, cause } = current as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    };

    if (name === "UserRejectedRequestError") return true;
    if (REJECTION_CODES.has(code)) return true;
    if (cause === undefined || cause === current) return false;

    current = cause;
  }

  return false;
}
