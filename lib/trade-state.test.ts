import { describe, expect, it } from "vitest";

import {
  tradeState,
  txPhase,
  type TradeInput,
  type TradeState,
  type TxPhase,
  type TxSignal,
} from "@/lib/trade-state";
import type { WalletState } from "@/lib/wallet-state";

/**
 * The whole trade panel's logic, tested without wagmi, React or a browser — the
 * same arrangement as `lib/wallet-state.test.ts`, because it is the same kind of
 * function.
 *
 * Most of these tests are about precedence rather than about one state. That is
 * where the bugs live: every individual answer here is obvious, and the ones that
 * are wrong are wrong because something further along the flow should have been
 * answered first.
 */

const READY_WALLET: WalletState = { kind: "ready", lowEth: false };

/** Every wallet situation that is not `ready`. All of them block. */
const BLOCKING: WalletState[] = [
  { kind: "no-wallet" },
  { kind: "disconnected" },
  { kind: "connecting" },
  { kind: "wrong-chain", chainId: 1 },
  { kind: "balances-unreadable" },
  { kind: "checking" },
  { kind: "no-eth" },
  { kind: "no-usdc" },
];

/** $30 in, approved, quoted, nothing in flight — what each case departs from. */
function input(overrides: Partial<TradeInput> = {}): TradeInput {
  return {
    wallet: READY_WALLET,
    allowance: 50_000_000n,
    amountIn: 30_000_000n,
    building: false,
    approval: "idle",
    swap: "idle",
    quoteExpired: false,
    ...overrides,
  };
}

const kindOf = (overrides: Partial<TradeInput> = {}): TradeState["kind"] =>
  tradeState(input(overrides)).kind;

describe("tradeState: the wallet gate", () => {
  it("blocks on every wallet state but ready, carrying its kind", () => {
    for (const wallet of BLOCKING) {
      expect(tradeState(input({ wallet })), wallet.kind).toEqual({
        kind: "blocked",
        wallet: wallet.kind,
      });
    }
  });

  it("does not block on the low-ETH warning", () => {
    // `lowEth` is a warning and never a gate — the panel shows the estimate beside
    // the button. Blocking here would refuse trades that would have gone through.
    expect(kindOf({ wallet: { kind: "ready", lowEth: true } })).toBe("ready");
  });

  it("outranks the allowance and the quote", () => {
    // Nothing below the wallet gate is actionable, so neither has anything to say.
    expect(
      kindOf({
        wallet: { kind: "disconnected" },
        allowance: 0n,
        quoteExpired: true,
      }),
    ).toBe("blocked");
  });
});

describe("tradeState: the approval decision", () => {
  it("asks for an approval when the router may not spend enough", () => {
    expect(tradeState(input({ allowance: 0n }))).toEqual({
      kind: "needs-approval",
      required: 30_000_000n,
    });
  });

  it("treats an allowance equal to the amount as enough", () => {
    expect(kindOf({ allowance: 30_000_000n })).toBe("ready");
    expect(kindOf({ allowance: 29_999_999n })).toBe("needs-approval");
  });

  it("waits for the read rather than reading null as zero", () => {
    // The bug this prevents: an approve step shown to someone who has already
    // approved, who then pays for a second approval.
    expect(kindOf({ allowance: null })).toBe("checking-allowance");
  });

  it("does not let a confirmed approval stand in for the read", () => {
    // The rule from the module note, and the only test of it. `approve` can be
    // front-run to zero and a wallet can approve a different amount than it was
    // asked for, so a swap sent against an assumed allowance reverts.
    expect(kindOf({ approval: "confirmed", allowance: null })).toBe(
      "checking-allowance",
    );
    expect(kindOf({ approval: "confirmed", allowance: 0n })).toBe(
      "needs-approval",
    );
    expect(kindOf({ approval: "confirmed", allowance: 50_000_000n })).toBe(
      "ready",
    );
  });
});

describe("tradeState: an expired quote", () => {
  it("outranks the approval step, because approving costs gas", () => {
    // The required ordering. An approval sent against a stale quote is a real fee
    // for permission computed from a price that no longer holds: re-quote first,
    // then approve once, for the right number.
    expect(kindOf({ quoteExpired: true, allowance: 0n })).toBe("quote-expired");
  });

  it("outranks a pending allowance read", () => {
    expect(kindOf({ quoteExpired: true, allowance: null })).toBe(
      "quote-expired",
    );
  });

  it("does not outrank an approval already in flight", () => {
    // An allowance is not priced, so a quote ageing out under a pending approval
    // invalidates nothing about it. The panel re-quotes underneath.
    expect(kindOf({ quoteExpired: true, approval: "signing" })).toBe(
      "approving",
    );
    expect(kindOf({ quoteExpired: true, approval: "confirming" })).toBe(
      "approval-confirming",
    );
  });

  it("does not outrank a build in flight", () => {
    // `/api/build` fetches its own fresh route and checks it against the floor we
    // showed, which is exactly this case handled properly rather than abandoned.
    expect(kindOf({ quoteExpired: true, building: true })).toBe("building");
  });

  it("does not outrank a swap in flight", () => {
    // A swap signed with seconds left crosses the expiry while it confirms. Saying
    // "quote expired" over a transaction in the mempool would read as a loss.
    expect(kindOf({ quoteExpired: true, swap: "signing" })).toBe("signing");
    expect(kindOf({ quoteExpired: true, swap: "confirming" })).toBe(
      "confirming",
    );
  });
});

describe("tradeState: the two transactions", () => {
  it("names the step a failure happened in", () => {
    // Two transactions, so "declined" is ambiguous on its own: the copy has to say
    // which one, and the state is where that comes from.
    const outcomes: TxPhase[] = ["rejected", "reverted", "failed"];

    for (const phase of outcomes) {
      expect(tradeState(input({ approval: phase })), phase).toEqual({
        kind: phase,
        step: "approval",
      });
      expect(tradeState(input({ swap: phase })), phase).toEqual({
        kind: phase,
        step: "swap",
      });
    }
  });

  it("reports the swap's outcome when both went wrong", () => {
    // An approval that was declined and then a swap that reverted is not a
    // sequence that can happen, but if state is left behind, the later one is the
    // one the user just watched.
    expect(tradeState(input({ approval: "rejected", swap: "reverted" }))).toEqual(
      { kind: "reverted", step: "swap" },
    );
  });

  it("reports the swap over an approval still on screen", () => {
    expect(kindOf({ approval: "signing", swap: "confirming" })).toBe(
      "confirming",
    );
  });

  it("has an answer for every phase of both transactions", () => {
    /*
     * Exhaustive by type: `Record<TxPhase, …>` fails to compile if a phase is added
     * to the union without a row here, and the loop reads its keys rather than a
     * second list, so there is nothing to keep in step by hand.
     */
    const forSwap: Record<TxPhase, TradeState["kind"]> = {
      idle: "ready",
      signing: "signing",
      confirming: "confirming",
      confirmed: "confirmed",
      reverted: "reverted",
      rejected: "rejected",
      failed: "failed",
    };

    const forApproval: Record<TxPhase, TradeState["kind"]> = {
      idle: "ready",
      signing: "approving",
      confirming: "approval-confirming",
      // Not a state of its own: a successful approval stops being a step, and the
      // allowance read decides what comes next. Here it says approved.
      confirmed: "ready",
      reverted: "reverted",
      rejected: "rejected",
      failed: "failed",
    };

    for (const phase of Object.keys(forSwap) as TxPhase[]) {
      expect(kindOf({ swap: phase }), `swap ${phase}`).toBe(forSwap[phase]);
      expect(kindOf({ approval: phase }), `approval ${phase}`).toBe(
        forApproval[phase],
      );
    }
  });
});

describe("tradeState: after a confirmed swap", () => {
  it("shows the receipt over the allowance it spent and the quote it outlived", () => {
    // The load-bearing precedence. A settled buy spends its allowance and outlives
    // its quote, so every check below this one would be true and wrong: without it
    // the panel says "approve your USDC" over a trade that already happened.
    expect(
      kindOf({ swap: "confirmed", allowance: 0n, quoteExpired: true }),
    ).toBe("confirmed");
  });

  it("shows the receipt even if the wallet went away", () => {
    // The receipt lands through the public client, and a disconnect afterwards is
    // not a reason to erase what happened to someone's money.
    expect(
      kindOf({ swap: "confirmed", wallet: { kind: "disconnected" } }),
    ).toBe("confirmed");
  });

  it("does not read a confirmed approval as a confirmed trade", () => {
    expect(kindOf({ approval: "confirmed" })).toBe("ready");
  });
});

describe("tradeState: every state is reachable", () => {
  /**
   * One input per state, and the claim that this is all of them.
   *
   * The panel renders a branch per kind, so a state nothing can produce is dead
   * copy and a state nothing here names is copy nobody wrote. Adding a kind to the
   * union without adding a row makes this fail, which is the point.
   */
  const table: ReadonlyArray<readonly [TradeState["kind"], Partial<TradeInput>]> =
    [
      ["blocked", { wallet: { kind: "disconnected" } }],
      ["quote-expired", { quoteExpired: true }],
      ["checking-allowance", { allowance: null }],
      ["needs-approval", { allowance: 0n }],
      ["approving", { approval: "signing" }],
      ["approval-confirming", { approval: "confirming" }],
      ["ready", {}],
      ["building", { building: true }],
      ["signing", { swap: "signing" }],
      ["confirming", { swap: "confirming" }],
      ["confirmed", { swap: "confirmed" }],
      ["reverted", { swap: "reverted" }],
      ["rejected", { swap: "rejected" }],
      ["failed", { swap: "failed" }],
    ];

  it("produces each kind from the input that should produce it", () => {
    for (const [kind, overrides] of table) {
      expect(kindOf(overrides), kind).toBe(kind);
    }
  });

  it("covers the whole union", () => {
    const covered = new Set(table.map(([kind]) => kind));
    const all: TradeState["kind"][] = [
      "blocked",
      "quote-expired",
      "checking-allowance",
      "needs-approval",
      "approving",
      "approval-confirming",
      "ready",
      "building",
      "signing",
      "confirming",
      "confirmed",
      "reverted",
      "rejected",
      "failed",
    ];

    expect([...covered].sort()).toEqual([...all].sort());
  });
});

/** Nothing asked for, nothing sent. Every case below departs from this. */
function signal(overrides: Partial<TxSignal> = {}): TxSignal {
  return {
    signing: false,
    hash: null,
    writeError: null,
    receipt: null,
    receiptError: null,
    ...overrides,
  };
}

const HASH = "0x" + "ab".repeat(32);

describe("txPhase: the ordinary path", () => {
  it("is idle before anything is asked for", () => {
    expect(txPhase(signal())).toBe("idle");
  });

  it("is signing while the wallet holds the request", () => {
    expect(txPhase(signal({ signing: true }))).toBe("signing");
  });

  it("is confirming once there is a hash and no receipt", () => {
    expect(txPhase(signal({ hash: HASH }))).toBe("confirming");
  });

  it("is confirmed on a successful receipt", () => {
    expect(txPhase(signal({ hash: HASH, receipt: "success" }))).toBe(
      "confirmed",
    );
  });
});

describe("txPhase: a receipt that came back reverted", () => {
  it("is a failure even though the transaction landed", () => {
    // The whole reason this function exists. A reverted transaction was mined and
    // paid for and bought nothing, and code that only checks whether a receipt
    // arrived reads it as success.
    expect(txPhase(signal({ hash: HASH, receipt: "reverted" }))).toBe("reverted");
  });

  it("cannot be reported as confirmed by anything else on the signal", () => {
    // Belt and braces on the precedence: a stale pending flag or a write error
    // alongside a reverted receipt must not change the answer.
    expect(
      txPhase(
        signal({
          signing: true,
          hash: HASH,
          receipt: "reverted",
          writeError: new Error("noise"),
        }),
      ),
    ).toBe("reverted");
  });
});

describe("txPhase: a signature that did not happen", () => {
  it("reads a dismissed wallet prompt as a choice, not a fault", () => {
    // `isUserRejection` from `lib/wallet-state.ts`, reused rather than duck-typed a
    // second time. The shapes it recognises are covered there.
    for (const writeError of [
      { name: "UserRejectedRequestError" },
      { code: 4001 },
      { name: "Outer", cause: { code: "ACTION_REJECTED" } },
    ]) {
      expect(txPhase(signal({ writeError })), JSON.stringify(writeError)).toBe(
        "rejected",
      );
    }
  });

  it("reads anything else as ours to explain", () => {
    expect(txPhase(signal({ writeError: new Error("insufficient funds") }))).toBe(
      "failed",
    );
    expect(txPhase(signal({ writeError: { code: -32002 } }))).toBe("failed");
  });

  it("outranks a pending flag left behind by the same attempt", () => {
    expect(
      txPhase(signal({ signing: true, writeError: { code: 4001 } })),
    ).toBe("rejected");
  });
});

describe("txPhase: a receipt we could not fetch", () => {
  it("is failed rather than reverted, because we do not know", () => {
    // The distinction the copy depends on: the transaction may well have settled,
    // so the panel sends the user to Basescan instead of telling them it failed.
    expect(
      txPhase(signal({ hash: HASH, receiptError: new Error("timeout") })),
    ).toBe("failed");
  });

  it("does not override a receipt that did arrive", () => {
    expect(
      txPhase(
        signal({
          hash: HASH,
          receipt: "success",
          receiptError: new Error("a later poll failed"),
        }),
      ),
    ).toBe("confirmed");
  });
});

describe("txPhase: the shapes wagmi actually hands over", () => {
  it("treats undefined the same as null on both errors", () => {
    // wagmi's mutations report `error: null`; its queries report `undefined`. Both
    // mean nothing went wrong, and reading either as an error would report a failure
    // over a transaction that is merely still confirming.
    expect(
      txPhase({
        signing: false,
        hash: HASH,
        writeError: undefined,
        receipt: null,
        receiptError: undefined,
      }),
    ).toBe("confirming");
  });

  it("produces every phase in the union", () => {
    const table: ReadonlyArray<readonly [TxPhase, Partial<TxSignal>]> = [
      ["idle", {}],
      ["signing", { signing: true }],
      ["confirming", { hash: HASH }],
      ["confirmed", { receipt: "success" }],
      ["reverted", { receipt: "reverted" }],
      ["rejected", { writeError: { code: 4001 } }],
      ["failed", { writeError: new Error("nope") }],
    ];

    const covered = new Set(table.map(([phase]) => phase));
    const all: TxPhase[] = [
      "idle",
      "signing",
      "confirming",
      "confirmed",
      "reverted",
      "rejected",
      "failed",
    ];

    for (const [phase, overrides] of table) {
      expect(txPhase(signal(overrides)), phase).toBe(phase);
    }

    expect([...covered].sort()).toEqual([...all].sort());
  });
});
