"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { CompanyIcon } from "@/components/Brand";
import { ConnectModal } from "@/components/ConnectModal";
import { NairaAmount } from "@/components/NairaAmount";
import { useClock } from "@/hooks/useClock";
import { useQuote, type QuoteStatus, type UseQuoteResult } from "@/hooks/useQuote";
import { useStockPrices } from "@/hooks/useStockPrices";
import { useTrade, type TradeFault, type UseTradeResult } from "@/hooks/useTrade";
import { useWallet } from "@/hooks/useWallet";
import {
  formatBourseFee,
  formatFloor,
  formatNGNAmount,
  formatPremiumBps,
  formatShares,
  formatSpread,
  formatFeedAge,
  parseNgnAmount,
} from "@/lib/format";
import { floorNgn } from "@/lib/quote-ngn";
import { basescanTxUrl } from "@/lib/rpc";
import {
  STOCK_TOKENS,
  USDC_DECIMALS,
  type StockSymbol,
} from "@/lib/tokens";
import type { TradeState, TradeStep } from "@/lib/trade-state";
import type { WalletState } from "@/lib/wallet-state";

/**
 * One market on the ported trade visual, with the live buy behind it.
 *
 * The layout, classes and copy shape are the reference design's StockDetail;
 * every figure is ours. Two numbers on purpose: the Chainlink reference up
 * top (captioned with its own age) and the live pool price where their chart
 * sat — the chart area renders no history because we hold none, and invented
 * points would be the one thing the design may not have.
 *
 * The three hooks are called here and nowhere below, in dependency order:
 * `useWallet` needs the quote's fee for the low-ETH judgement, `useTrade`
 * needs both the quote and the wallet, each exactly once.
 */

const DEFAULT_AMOUNT = "50,000";

export function TradeDetail({ symbol }: { symbol: StockSymbol }) {
  const token = STOCK_TOKENS[symbol];
  const { prices, ngnRate } = useStockPrices();
  const nowMs = useClock();

  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [tradeType, setTradeType] = useState<"Buy" | "Sell">("Buy");
  const [connectOpen, setConnectOpen] = useState(false);
  const ngn = parseNgnAmount(amount);

  const price = prices[symbol];
  const age = formatFeedAge(price.updatedAt, nowMs);

  const quote = useQuote({
    symbol,
    ngn,
    usdToNgnRate: ngnRate,
    referenceUsd: price.usd,
  });

  const wallet = useWallet({ gasWei: quote.ngnQuote?.quote.gasWei ?? null });

  const trade = useTrade({
    quote: quote.ngnQuote?.quote ?? null,
    quoteExpired: quote.expired,
    refreshQuote: quote.refresh,
    wallet: wallet.state,
    owner: wallet.address,
  });

  // The modal has done its job once an account is connected.
  useEffect(() => {
    if (wallet.address !== null) setConnectOpen(false);
  }, [wallet.address]);

  const ngnQuote = quote.ngnQuote;
  const priced = ngnQuote !== null;
  const state = trade.state;

  const availableNgn =
    wallet.usdcUnits !== null && ngnRate !== null
      ? (Number(wallet.usdcUnits) / 10 ** USDC_DECIMALS) * ngnRate
      : null;

  const floor = floorNgn(
    trade.minAmountOut,
    token.decimals,
    ngnQuote?.ngnPerShare ?? null,
  );

  const press = tradeType === "Buy" ? panelAction(state, token.tokenSymbol, ngnQuote?.ngnIn ?? null, trade) : null;
  const note = tradeType === "Buy" ? signatureNote(state, ngnQuote?.ngnIn ?? null) : null;
  const moment = tradeType === "Buy" ? momentCopy(state, trade.fault, trade.repriced) : null;
  const hash = tradeType === "Buy" ? txHash(state, trade.approvalHash, trade.swapHash) : null;
  const tone = tradeType === "Buy" ? momentTone(state, trade.fault, trade.repriced) : "plain";
  const statusLine = tradeType === "Buy" ? statusCopy(quote) : null;

  const lowEth =
    (wallet.state.kind === "ready" || wallet.state.kind === "no-usdc") &&
    wallet.state.lowEth;

  return (
    <AppShell walletAddress={wallet.address}>
      <div className="detail-back">
        <Link href="/markets">
          <ArrowRight size={15} className="back-arrow" /> Back to markets
        </Link>
      </div>

      <div className="detail-layout">
        <div className="detail-main">
          <div className="detail-top">
            <div className="stock-identity">
              <CompanyIcon symbol={symbol} />
              <div>
                <div className="eyebrow">TOKENIZED STOCK</div>
                <h1>
                  {token.name} <span>{symbol}</span>
                </h1>
              </div>
            </div>
          </div>

          <div className="detail-price">
            <strong>
              <NairaAmount value={formatNGNAmount(price.ngn)} rate={ngnRate}>
                {formatNGNAmount(price.ngn)}
              </NairaAmount>
            </strong>
            {/* The age stated factually, never as an alarm: feeds publish 24/5
                while the token trades 24/7, so a stale reading is the ordinary
                Lagos afternoon rather than a fault. */}
            <span>
              {price.unusable !== null
                ? "No reference price yet"
                : age === null
                  ? "Reference price"
                  : `Reference ${age} · feeds update 24/5`}
            </span>
          </div>

          {/* No period buttons: there is no price history to scope, and a
              control that cannot act is worse than none. The row keeps its
              place and states the one timing that is real. */}
          <div className="chart-periods">
            <span className="chart-updated">
              <i />{" "}
              {priced && !quote.expired
                ? "Live pool price · what a buy settles near"
                : quote.status === "no-liquidity"
                  ? "No route at this size right now"
                  : "Waiting for a price"}
            </span>
          </div>

          {/* Their chart area, honestly: the current pool price large, never
              invented points. */}
          <div className="detail-chart">
            <div className="eyebrow">LIVE POOL PRICE</div>
            <div className="detail-price">
              <strong>
                {ngnQuote?.ngnPerShare === undefined ||
                ngnQuote.ngnPerShare === null ? (
                  "—"
                ) : (
                  <NairaAmount
                    value={formatNGNAmount(ngnQuote.ngnPerShare)}
                    rate={ngnRate}
                  >
                    {formatNGNAmount(ngnQuote.ngnPerShare)}
                  </NairaAmount>
                )}
              </strong>
              <span>
                {priced
                  ? "Never fewer than the floor below"
                  : "Type an amount to price it"}
              </span>
            </div>
          </div>

          <div className="detail-info">
            <div>
              <div className="eyebrow">ABOUT {symbol}</div>
              <p>
                {token.name} builds products used by millions of people every
                day. Own a tokenized share and follow its value directly in
                your Bourse portfolio.
              </p>
            </div>
            {/* Open, high, low and market cap have no source, so the cells stay
                empty and the grid keeps its shape. */}
            <div className="key-stats" />
          </div>
        </div>

        <aside className="trade-panel">
          <div className="trade-panel-head">
            <div>
              <div className="eyebrow">TRADE {token.tokenSymbol}</div>
              <h2>Make a move.</h2>
            </div>
          </div>

          <div className="trade-toggle">
            <button
              type="button"
              className={tradeType === "Buy" ? "active" : ""}
              onClick={() => setTradeType("Buy")}
            >
              Buy
            </button>
            <button
              type="button"
              className={tradeType === "Sell" ? "active" : ""}
              onClick={() => setTradeType("Sell")}
            >
              Sell
            </button>
          </div>

          {tradeType === "Sell" ? (
            <>
              <p className="trade-note">
                Selling is not available yet. Buying works now.
              </p>
              <button
                type="button"
                className="button button-dark full-width"
                disabled
              >
                Sell {token.tokenSymbol}
              </button>
            </>
          ) : (
            <>
              <label className="field-label" htmlFor="trade-amount">
                Amount in naira <span>Available {formatNGNAmount(availableNgn)}</span>
              </label>
              <div className="trade-input">
                <span>₦ </span>
                <input
                  id="trade-amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="trade-amount-status"
                />
              </div>

              <div className="estimate-row">
                <span>Estimated shares</span>
                <strong>
                  {formatShares(ngnQuote?.quote.shares ?? null)}{" "}
                  {token.tokenSymbol}
                </strong>
              </div>
              <div className="estimate-row">
                <span>Least you&apos;ll receive</span>
                <strong>
                  {formatFloor(floor.shares, floor.ngn, token.tokenSymbol)}
                </strong>
              </div>
              <div className="estimate-row">
                <span>Premium vs reference</span>
                <strong>
                  {formatPremiumBps(ngnQuote?.premiumBps ?? null)}
                </strong>
              </div>
              <div className="estimate-row">
                <span>Market spread</span>
                <strong>
                  {formatSpread(
                    ngnQuote?.spreadNgn ?? null,
                    ngnQuote?.quote.executionCostBps ?? null,
                  )}
                </strong>
              </div>
              <div className="estimate-row">
                <span>Bourse fee</span>
                <strong>{formatBourseFee(ngnQuote?.feeNgn ?? null)}</strong>
              </div>

              <div className="trade-breakdown">
                <span>
                  <span>Rate</span>
                  <strong>
                    1 {token.tokenSymbol} ={" "}
                    {formatNGNAmount(ngnQuote?.ngnPerShare ?? null)}
                  </strong>
                </span>
                <span>
                  <span>Network fee</span>
                  <strong>
                    ≈ {formatNGNAmount(ngnQuote?.gasNgn ?? null)}
                  </strong>
                </span>
                <span>
                  <span>Quote held for</span>
                  <strong className="countdown">
                    {countdown(quote.secondsRemaining)}
                  </strong>
                </span>
              </div>

              <p id="trade-amount-status" className="trade-note" aria-live="polite">
                {statusLine}
              </p>

              {note === null ? null : <p className="trade-note">{note}</p>}

              {/* A warning, never a gate: the button below stays pressable. */}
              {lowEth ? (
                <p className="trade-note countdown">
                  The ETH in this wallet is low. A buy is two transactions —
                  an approval, then the purchase — and there is not much room
                  here for the second one if fees rise between them. A little
                  more ETH avoids that.
                </p>
              ) : null}

              {press === null ? null : (
                <button
                  type="button"
                  className="button button-dark full-width"
                  disabled={!press.enabled}
                  onClick={() => {
                    if (press.press === "connect") {
                      setConnectOpen(true);
                    } else if (press.press === "retry") {
                      trade.retry();
                    } else {
                      trade.submit();
                    }
                  }}
                >
                  {press.label} <ArrowRight size={16} />
                </button>
              )}

              {/* The one control that fixes a wallet state the button only
                  names, in their text-link style. */}
              {state?.kind === "blocked" &&
              state.wallet === "wrong-chain" ? (
                <p className="trade-note">
                  <button
                    type="button"
                    className="text-link"
                    onClick={wallet.switchToBase}
                    disabled={wallet.switching}
                  >
                    {wallet.switching ? "Switching…" : "Switch to Base"}
                    <ArrowRight size={15} />
                  </button>
                </p>
              ) : null}
              {state?.kind === "blocked" &&
              state.wallet === "balances-unreadable" ? (
                <p className="trade-note">
                  <button
                    type="button"
                    className="text-link"
                    onClick={wallet.refetchBalances}
                  >
                    Check again <ArrowRight size={15} />
                  </button>
                </p>
              ) : null}

              {moment === null && hash === null ? null : (
                <p
                  className={
                    tone === "plain"
                      ? "trade-note"
                      : `trade-note ${tone === "positive" ? "positive" : tone === "negative" ? "negative" : "countdown"}`
                  }
                  aria-live="polite"
                >
                  {moment}{" "}
                  {hash === null ? null : (
                    <a
                      className="text-link"
                      href={basescanTxUrl(hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View transaction
                    </a>
                  )}
                </p>
              )}

              <p className="trade-note">
                You&apos;ll review the full quote before signing in your
                wallet.
              </p>
            </>
          )}
        </aside>
      </div>

      <ConnectModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        connectors={wallet.connectors}
        onConnect={wallet.connect}
      />
    </AppShell>
  );
}

/** Their `00:30` countdown, from live seconds. `—` with no quote held. */
function countdown(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

type PanelAction = {
  label: string;
  enabled: boolean;
  press: "submit" | "retry" | "connect";
};

/**
 * The one button, in their full-width dark style. Labels mirror the trade
 * states one-to-one: waiting states say what is being waited for, and a
 * disconnected wallet gets a working connect action rather than a dead end.
 */
function panelAction(
  state: TradeState | null,
  tokenSymbol: string,
  ngnIn: number | null,
  trade: UseTradeResult,
): PanelAction | null {
  if (state === null) return null;

  switch (state.kind) {
    case "blocked":
      if (state.wallet === "disconnected" || state.wallet === "no-wallet") {
        return { label: "Connect a wallet to buy", enabled: true, press: "connect" };
      }
      return { label: blockedLabel(state.wallet), enabled: false, press: "submit" };
    case "quote-expired":
      return { label: "Get a new price", enabled: true, press: "submit" };
    case "insufficient-balance":
      // Unreachable on this screen: buys judge USDC in the wallet panel and
      // pass a null balance, while sells are not wired yet. Present because
      // the union grew a member and an inexhaustive switch would return
      // undefined into a button label.
      return { label: "Not enough balance to sell", enabled: false, press: "submit" };
    case "checking-allowance":
      return { label: "Checking your permission", enabled: false, press: "submit" };
    case "needs-approval":
      return {
        label:
          ngnIn === null
            ? "Approve this amount"
            : `Approve ${formatNGNAmount(ngnIn)}`,
        enabled: true,
        press: "submit",
      };
    case "approving":
      return { label: "Approve it in your wallet", enabled: false, press: "submit" };
    case "approval-confirming":
      return { label: "Recording your permission", enabled: false, press: "submit" };
    case "ready":
      if (trade.awaitingReprice) {
        return { label: "Getting the new price", enabled: false, press: "submit" };
      }
      return trade.repriced
        ? { label: "Buy at this new price", enabled: true, press: "submit" }
        : { label: `Buy ${tokenSymbol}`, enabled: true, press: "submit" };
    case "building":
      return { label: "Getting the final price", enabled: false, press: "submit" };
    case "signing":
      return { label: "Confirm the purchase in your wallet", enabled: false, press: "submit" };
    case "confirming":
      return { label: "Your purchase is going through", enabled: false, press: "submit" };
    case "confirmed":
      return { label: "Buy again", enabled: true, press: "retry" };
    case "rejected":
      return { label: "Try again", enabled: true, press: "retry" };
    case "reverted":
      return { label: "Try again with a new price", enabled: true, press: "retry" };
    case "failed":
      if (trade.fault?.kind === "unsafe-build") return null;
      return { label: "Try again", enabled: true, press: "retry" };
  }
}

function blockedLabel(wallet: WalletState["kind"]): string {
  switch (wallet) {
    case "no-wallet":
      return "A wallet is needed to buy";
    case "disconnected":
      return "Connect a wallet to buy";
    case "connecting":
      return "Waiting for your wallet";
    case "wrong-chain":
      return "Switch to Base to buy";
    case "balances-unreadable":
      return "We could not read your balances";
    case "checking":
      return "Checking what you hold";
    case "no-eth":
      return "ETH is needed for the network fee";
    case "no-usdc":
      return "Add USDC to buy";
    case "ready":
      return "Buy";
  }
}

/** The line under the amount field. The price, never the purchase. */
function statusCopy({
  status,
  minNgn,
  maxNgn,
  expired,
}: UseQuoteResult): string | null {
  switch (status) {
    case "idle":
      return "Enter an amount to see what it buys.";
    case "unquotable":
      return "This stock is issued on Base but has no pool yet, so it cannot be bought here.";
    case "too-small":
      return minNgn === null
        ? "That is less than we can price."
        : `The smallest amount we can price is ${formatNGNAmount(minNgn)}.`;
    case "too-large":
      return maxNgn === null
        ? "That is more than we can price."
        : `The largest amount we can price is ${formatNGNAmount(maxNgn)}.`;
    case "loading":
      return "Getting a price.";
    case "quote":
      return expired ? "Getting a fresh price." : null;
    case "no-liquidity":
      return "There is no route for this amount right now. A smaller amount may still go through.";
    case "failed":
      return "We could not get a price just now.";
  }
}

/** Before the first prompt, never after it. */
function signatureNote(state: TradeState | null, ngnIn: number | null): string | null {
  if (state === null) return null;

  const amount = ngnIn === null ? "this amount" : formatNGNAmount(ngnIn);

  switch (state.kind) {
    case "needs-approval":
      return (
        `This purchase takes two signatures. The first permits ${amount} of your ` +
        "USDC and no more — it is not an unlimited allowance. The second buys the " +
        "shares."
      );
    case "approving":
      return (
        `The first of the two: permission for ${amount}, and nothing beyond it. ` +
        "The second signature is the purchase itself."
      );
    case "approval-confirming":
      return "That was the first of two signatures. The purchase is the second.";
    case "ready":
      return (
        "One signature. Permission for this amount is already in place, so the only " +
        "thing left to sign is the purchase."
      );
    default:
      return null;
  }
}

/** What just happened, in one sentence. Every ending says what left the wallet. */
function momentCopy(
  state: TradeState | null,
  fault: TradeFault | null,
  repriced: boolean,
): string | null {
  if (state === null) return null;

  switch (state.kind) {
    case "blocked":
    case "checking-allowance":
    case "needs-approval":
    case "approving":
    case "building":
    case "signing":
      return null;
    case "quote-expired":
      return "That price has run out. A new one is on its way.";
    case "insufficient-balance":
      // Unreachable here for the reason above; the button names it.
      return null;
    case "approval-confirming":
      return "Base is recording your permission. This usually takes a few seconds.";
    case "ready":
      return repriced
        ? "The price moved while your purchase was being put together, so nothing was sent and the figures above are a fresh quote. Buy again if they still work for you."
        : null;
    case "confirming":
      return "Your purchase is on Base and usually settles within a few seconds.";
    case "confirmed":
      return "Bought. The shares are in your wallet.";
    case "reverted":
      return revertedCopy(state.step);
    case "rejected":
      return state.step === "approval"
        ? "You declined the permission in your wallet. Nothing was spent."
        : "You declined the purchase in your wallet. Nothing was spent.";
    case "failed":
      return fault === null ? lostCopy(state.step) : faultCopy(fault);
  }
}

function revertedCopy(step: TradeStep): string {
  if (step === "approval") {
    return (
      "The permission reached Base and did not go through. Its network fee was " +
      "spent, and your USDC was not touched. Signing it again usually works."
    );
  }

  return (
    "Your purchase reached Base and did not go through. The network fee for it was " +
    "spent; nothing else left your wallet. The usual cause is the price moving past " +
    "the floor above while the transaction was in flight, so the answer is a new " +
    "price rather than the same one again."
  );
}

function lostCopy(step: TradeStep): string {
  if (step === "approval") {
    return (
      "We lost track of the permission transaction. Check it on Basescan before " +
      "signing again — if it went through, you will not need to."
    );
  }

  return (
    "We lost track of your purchase, so we cannot say whether it settled. Check it " +
    "on Basescan before buying again."
  );
}

function faultCopy(fault: TradeFault): string {
  switch (fault.kind) {
    case "unsafe-build":
      return (
        "The purchase we were handed did not match the exchange Bourse is pinned to, " +
        "so we did not sign it. Nothing was spent. Reload this page before trying " +
        "again — we will not send a transaction we cannot verify."
      );
    case "no-route":
      return (
        "There is no route for this amount right now. Nothing was signed. A smaller " +
        "amount may still go through."
      );
    case "build-failed":
      return "We could not put the purchase together. Nothing was signed and nothing was spent.";
  }
}

function txHash(
  state: TradeState | null,
  approvalHash: string | null,
  swapHash: string | null,
): string | null {
  if (state === null) return null;

  switch (state.kind) {
    case "approval-confirming":
      return approvalHash;
    case "confirming":
    case "confirmed":
      return swapHash;
    case "reverted":
    case "failed":
      return state.step === "approval" ? approvalHash : swapHash;
    default:
      return null;
  }
}

type MomentTone = "plain" | "notice" | "negative" | "positive";

/** Colour is never the only signal — every toned state carries a sentence. */
function momentTone(
  state: TradeState | null,
  fault: TradeFault | null,
  repriced: boolean,
): MomentTone {
  if (state === null) return "plain";

  switch (state.kind) {
    case "confirmed":
      return "positive";
    case "reverted":
      return "negative";
    case "failed":
      return fault?.kind === "no-route" ? "notice" : "negative";
    case "quote-expired":
      return "notice";
    case "ready":
      return repriced ? "notice" : "plain";
    default:
      return "plain";
  }
}
