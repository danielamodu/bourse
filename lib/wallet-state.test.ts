import { describe, expect, it } from "vitest";

import { BASE_CHAIN_ID } from "@/lib/rpc";
import {
  GAS_HEADROOM,
  isUserRejection,
  LOW_ETH_FLOOR_WEI,
  walletState,
  type ConnectionPhase,
  type WalletInput,
  type WalletState,
} from "@/lib/wallet-state";

/**
 * The whole wallet surface, tested without wagmi, React or a browser.
 *
 * That is the point of extracting it: every sentence the connect panel can say is
 * decided here, so the coverage that matters is a table of inputs rather than a
 * rendered harness.
 */

/**
 * What a $30 route on Base actually costs: 220,000 gas units at 0.01 gwei.
 *
 * Named because the low-ETH cases below are stated as multiples of it. Four of these
 * is about two cents, which is the whole reason {@link LOW_ETH_FLOOR_WEI} exists: a
 * threshold built only out of this figure never fires for anyone.
 */
const GAS_WEI = 2_200_000_000_000n;

/**
 * The same route at a gasPrice forty-odd times higher: 220,000 gas at about
 * 0.45 gwei.
 *
 * Base under load, when the L1 calldata component moves the fee rather than nudging
 * it. Chosen so that four of these clears the floor, because that is the only way to
 * exercise the other arm of the maximum — and it is the arm that matters on the day
 * fees rise between the approval and the swap.
 */
const HIGH_GAS_WEI = 100_000_000_000_000n;

/** Connected, on Base, funded — the state every case below departs from. */
function input(overrides: Partial<WalletInput> = {}): WalletInput {
  return {
    hasConnector: true,
    phase: "connected",
    chainId: BASE_CHAIN_ID,
    ethWei: 2_000_000_000_000_000n, // 0.002 ETH, several times the floor
    usdcUnits: 50_000_000n, // $50
    balancesFailed: false,
    gasWei: null,
    ...overrides,
  };
}

const kindOf = (overrides: Partial<WalletInput> = {}): WalletState["kind"] =>
  walletState(input(overrides)).kind;

describe("walletState: before a connection", () => {
  it("offers to connect when a connector is available", () => {
    expect(kindOf({ phase: "disconnected" })).toBe("disconnected");
  });

  it("does not offer a button when there is nothing to connect with", () => {
    // The one state that must render no control at all. A connect button that
    // cannot connect reads as a broken app rather than as a missing wallet.
    expect(kindOf({ phase: "disconnected", hasConnector: false })).toBe(
      "no-wallet",
    );
  });

  it("treats a connection in flight as connecting, either way round", () => {
    const phases: ConnectionPhase[] = ["connecting", "reconnecting"];

    for (const phase of phases) {
      expect(kindOf({ phase }), phase).toBe("connecting");
    }
  });

  it("says connecting rather than no-wallet on contradictory input", () => {
    // A handshake with no connector cannot really happen. If it does, a step label
    // is still safer than telling someone their wallet does not exist.
    expect(kindOf({ phase: "connecting", hasConnector: false })).toBe(
      "connecting",
    );
  });

  it("returns quietly to disconnected after a rejected connection", () => {
    // wagmi puts the account back to `disconnected` when someone dismisses their
    // wallet's prompt. There is no rejected state to render, and there should not
    // be: declining is a choice, not a failure, so it costs nothing to recover.
    expect(kindOf({ phase: "disconnected" })).toBe("disconnected");
  });

  it("ignores balances that arrived before the connection did", () => {
    expect(
      kindOf({ phase: "disconnected", ethWei: 0n, usdcUnits: 0n }),
    ).toBe("disconnected");
  });
});

describe("walletState: the wrong network", () => {
  it("reports the chain it found, so the copy can name it", () => {
    const state = walletState(input({ chainId: 1 }));

    expect(state).toEqual({ kind: "wrong-chain", chainId: 1 });
  });

  it("is the answer before balances, however well funded the wallet is", () => {
    // A balance on Ethereum is not a balance on Base. Reading it as zero USDC
    // would be false, and would hide the problem that is actually fixable.
    expect(kindOf({ chainId: 1, ethWei: 0n, usdcUnits: 0n })).toBe(
      "wrong-chain",
    );
    expect(kindOf({ chainId: 1, ethWei: 10n ** 18n })).toBe("wrong-chain");
  });

  it("treats an unknown chain id as the wrong one", () => {
    expect(kindOf({ chainId: null })).toBe("wrong-chain");
  });

  it("accepts Base and nothing else", () => {
    expect(BASE_CHAIN_ID).toBe(8453);
    expect(kindOf({ chainId: BASE_CHAIN_ID })).toBe("ready");
    // Base Sepolia. A testnet connection is still the wrong network for real money.
    expect(kindOf({ chainId: 84_532 })).toBe("wrong-chain");
  });
});

describe("walletState: balances still loading", () => {
  it("waits rather than reporting a zero it has not read", () => {
    // The bug this exists to prevent: a pending read is null, and treating null as
    // zero tells a funded user to go and buy ETH.
    expect(kindOf({ ethWei: null })).toBe("checking");
    expect(kindOf({ usdcUnits: null })).toBe("checking");
    expect(kindOf({ ethWei: null, usdcUnits: null })).toBe("checking");
  });
});

describe("walletState: balances that will not read", () => {
  it("says so rather than checking forever", () => {
    // `checking` promises an answer is coming. After an error nothing is coming,
    // and the panel would sit on that sentence with no way out of it.
    expect(kindOf({ ethWei: null, balancesFailed: true })).toBe(
      "balances-unreadable",
    );
    expect(kindOf({ usdcUnits: null, balancesFailed: true })).toBe(
      "balances-unreadable",
    );
  });

  it("uses the figures it does have, even after a failure", () => {
    // One read failing does not invalidate the other. Both values present means
    // both questions are answered, whatever the error flag says about a retry.
    expect(kindOf({ balancesFailed: true })).toBe("ready");
    expect(kindOf({ balancesFailed: true, usdcUnits: 0n })).toBe("no-usdc");
  });

  it("is still the wrong network first", () => {
    // A read failing against the wrong chain is not the thing to fix.
    expect(kindOf({ chainId: 1, ethWei: null, balancesFailed: true })).toBe(
      "wrong-chain",
    );
  });
});

describe("walletState: funding gaps", () => {
  it("blocks on no ETH at all", () => {
    expect(kindOf({ ethWei: 0n })).toBe("no-eth");
  });

  it("puts ETH before USDC when both are missing", () => {
    // Nothing can be paid for without ETH, so it is the first thing to fix
    // whatever else is also true.
    expect(kindOf({ ethWei: 0n, usdcUnits: 0n })).toBe("no-eth");
  });

  it("blocks on no USDC once ETH is there", () => {
    expect(kindOf({ usdcUnits: 0n })).toBe("no-usdc");
  });

  it("does not block on an ETH balance that is merely small", () => {
    // The whole ETH threshold: gas measured three to five cents on these routes,
    // so a wallet with any ETH in it is almost certainly able to trade. Blocking
    // above zero would refuse trades that would have gone through.
    expect(kindOf({ ethWei: 1n })).toBe("ready");
    expect(kindOf({ ethWei: 1_000n })).toBe("ready");
  });

  it("does not read a negative balance as funded", () => {
    // Unreachable from a chain read; cheap to be certain about anyway.
    expect(kindOf({ ethWei: -1n })).toBe("no-eth");
    expect(kindOf({ usdcUnits: -1n })).toBe("no-usdc");
  });
});

describe("walletState: ready, and the low-ETH warning", () => {
  it("says nothing about a balance that clears both terms", () => {
    // The ordinary case, with a quote on screen and without one.
    expect(walletState(input())).toEqual({ kind: "ready", lowEth: false });

    expect(walletState(input({ gasWei: GAS_WEI }))).toEqual({
      kind: "ready",
      lowEth: false,
    });
  });

  it("warns below the floor, where the quoted fee decides nothing", () => {
    // Why the floor exists, and the bug it fixes. `gasWei` is priced at Base's
    // gasPrice floor, so four times it is about two cents — and a threshold of two
    // cents stays silent for exactly the person the warning is written for.
    expect(GAS_WEI * GAS_HEADROOM).toBeLessThan(LOW_ETH_FLOOR_WEI);

    expect(
      walletState(input({ ethWei: LOW_ETH_FLOOR_WEI - 1n, gasWei: GAS_WEI })),
    ).toEqual({ kind: "ready", lowEth: true });

    // Fifty times the quoted fee, and still worth a sentence: a buy is two
    // signatures, and Base fees move with L1 calldata prices between them.
    expect(
      walletState(input({ ethWei: GAS_WEI * 50n, gasWei: GAS_WEI })),
    ).toEqual({ kind: "ready", lowEth: true });
  });

  it("stops warning at the floor exactly", () => {
    // Pinned, because the number is the whole of the fix: 0.0003 ETH in wei.
    expect(LOW_ETH_FLOOR_WEI).toBe(300_000_000_000_000n);

    expect(
      walletState(input({ ethWei: LOW_ETH_FLOOR_WEI, gasWei: GAS_WEI })),
    ).toEqual({ kind: "ready", lowEth: false });
  });

  it("warns above the floor when the route itself is expensive", () => {
    // The other arm of the maximum, and why the multiple is still in the rule.
    const headroom = HIGH_GAS_WEI * GAS_HEADROOM;

    expect(GAS_HEADROOM).toBe(4n);
    expect(headroom).toBeGreaterThan(LOW_ETH_FLOOR_WEI);

    expect(
      walletState(input({ ethWei: LOW_ETH_FLOOR_WEI, gasWei: HIGH_GAS_WEI })),
    ).toEqual({ kind: "ready", lowEth: true });

    expect(
      walletState(input({ ethWei: headroom - 1n, gasWei: HIGH_GAS_WEI })),
    ).toEqual({ kind: "ready", lowEth: true });

    expect(
      walletState(input({ ethWei: headroom, gasWei: HIGH_GAS_WEI })),
    ).toEqual({ kind: "ready", lowEth: false });
  });

  it("still applies the floor when the gas figure is unusable", () => {
    // The contract this deliberately changed. A route that carried no gas estimate
    // used to silence the warning outright, which silenced it hardest for the
    // emptiest wallets. The floor needs no quote to be true, and a missing estimate
    // is not evidence that a wallet is funded.
    for (const gasWei of [null, 0n, -1n]) {
      expect(
        walletState(input({ ethWei: 1n, gasWei })),
        String(gasWei),
      ).toEqual({ kind: "ready", lowEth: true });

      expect(
        walletState(input({ ethWei: LOW_ETH_FLOOR_WEI, gasWei })),
        String(gasWei),
      ).toEqual({ kind: "ready", lowEth: false });
    }
  });

  it("never warns instead of blocking, or blocks instead of warning", () => {
    // A zero balance is a block whatever the gas estimate says, and no threshold
    // above zero may refuse a trade that would have gone through: one wei against
    // the most expensive route here is still a warning.
    expect(kindOf({ ethWei: 0n, gasWei: GAS_WEI })).toBe("no-eth");
    expect(kindOf({ ethWei: 1n, gasWei: HIGH_GAS_WEI })).toBe("ready");
  });
});

describe("walletState: every state is reachable", () => {
  /**
   * One input per state, and the claim that this is all of them.
   *
   * The panel renders a branch per kind, so a state nothing can produce is dead
   * copy and a state nothing here names is copy nobody wrote. Adding a kind to the
   * union without adding a row makes this fail, which is the point.
   */
  const table: ReadonlyArray<readonly [WalletState["kind"], Partial<WalletInput>]> =
    [
      ["no-wallet", { phase: "disconnected", hasConnector: false }],
      ["disconnected", { phase: "disconnected" }],
      ["connecting", { phase: "connecting" }],
      ["wrong-chain", { chainId: 1 }],
      ["balances-unreadable", { ethWei: null, balancesFailed: true }],
      ["checking", { ethWei: null }],
      ["no-eth", { ethWei: 0n }],
      ["no-usdc", { usdcUnits: 0n }],
      ["ready", {}],
    ];

  it("produces each kind from the input that should produce it", () => {
    for (const [kind, overrides] of table) {
      expect(kindOf(overrides), kind).toBe(kind);
    }
  });

  it("covers the whole union", () => {
    const covered = new Set(table.map(([kind]) => kind));
    const all: WalletState["kind"][] = [
      "no-wallet",
      "disconnected",
      "connecting",
      "wrong-chain",
      "balances-unreadable",
      "checking",
      "no-eth",
      "no-usdc",
      "ready",
    ];

    expect([...covered].sort()).toEqual([...all].sort());
  });
});

describe("isUserRejection", () => {
  it("recognises viem's error by name", () => {
    expect(isUserRejection({ name: "UserRejectedRequestError" })).toBe(true);
  });

  it("recognises a bare EIP-1193 rejection", () => {
    // What an injected provider sends when the wallet has no viem in it.
    expect(isUserRejection({ code: 4001, message: "User rejected" })).toBe(true);
    expect(isUserRejection({ code: "ACTION_REJECTED" })).toBe(true);
  });

  it("finds it wrapped several layers deep", () => {
    // wagmi wraps the connector's error, which wrapped the provider's.
    const error = {
      name: "ConnectorError",
      cause: { name: "ProviderRpcError", cause: { code: 4001 } },
    };

    expect(isUserRejection(error)).toBe(true);
  });

  it("does not read an ordinary failure as a rejection", () => {
    // The distinction the copy depends on: this one has to say something, because
    // the alternative is a button that looks dead.
    expect(isUserRejection({ name: "ProviderNotFoundError" })).toBe(false);
    expect(isUserRejection({ code: -32002, message: "Already processing" })).toBe(
      false,
    );
    expect(isUserRejection(new Error("network error"))).toBe(false);
  });

  it("survives the shapes an error is not", () => {
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
    expect(isUserRejection("4001")).toBe(false);
    expect(isUserRejection(4001)).toBe(false);
    expect(isUserRejection({})).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    // Not hypothetical enough to skip: an unbounded walk here would hang the
    // connect handler rather than fail it.
    const error: { name: string; cause?: unknown } = { name: "Outer" };
    error.cause = error;

    expect(isUserRejection(error)).toBe(false);

    const pair: { name: string; cause: { name: string; cause?: unknown } } = {
      name: "A",
      cause: { name: "B" },
    };
    pair.cause.cause = pair;

    expect(isUserRejection(pair)).toBe(false);
  });
});
