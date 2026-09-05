"use client";

import Link from "next/link";
import { useState } from "react";

import { TradePanel } from "@/components/TradePanel";
import { WalletConnect } from "@/components/WalletConnect";
import { useClock } from "@/hooks/useClock";
import { useQuote } from "@/hooks/useQuote";
import { useStockPrices } from "@/hooks/useStockPrices";
import { useTrade } from "@/hooks/useTrade";
import { useWallet } from "@/hooks/useWallet";
import { cx } from "@/lib/cx";
import {
  formatFeedAge,
  formatNGNAmount,
  parseNgnAmount,
} from "@/lib/format";
import { STOCK_TOKENS, type StockSymbol } from "@/lib/tokens";

import styles from "./trade.module.css";

/**
 * One market, with a live quote and the buy behind it.
 *
 * The reference price at the top and the quote in the panel are two different
 * numbers on purpose. The reference is Chainlink's, publishes on US market hours,
 * and is captioned with its own age. The quote is what a pool will actually
 * charge right now, and it is the one the premium is measured against.
 *
 * Everything above the trade panel needs no wallet, which is the gating rule: the whole
 * market — price, quote, spread, fee, total, floor — reads with nothing connected, and
 * the first thing that asks for anything is the panel's own button.
 *
 * THE THREE HOOKS ARE CALLED HERE AND NOWHERE BELOW, and the order is the dependency
 * chain: `useWallet` needs the quote's fee to judge whether the ETH balance is thin,
 * `useTrade` needs both the quote and the wallet, and each is called exactly once. Two
 * calls to `useWallet` would mean two sets of balance reads against a rate-limited RPC
 * that could disagree on screen — the trade panel gates on the same wallet state
 * `WalletConnect` describes because it is literally the same object.
 */

/**
 * The field starts at ₦50,000 — the reference ticket the impact budget was
 * calibrated for, and a realistic first order. A prefilled amount means the panel
 * arrives with real figures rather than a column of dashes.
 */
const DEFAULT_AMOUNT = "50,000";

export function TradeDetail({ symbol }: { symbol: StockSymbol }) {
  const token = STOCK_TOKENS[symbol];
  const { prices, ngnRate } = useStockPrices();
  const nowMs = useClock();

  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const ngn = parseNgnAmount(amount);

  const price = prices[symbol];
  const age = formatFeedAge(price.updatedAt, nowMs);

  const quote = useQuote({
    symbol,
    ngn,
    usdToNgnRate: ngnRate,
    referenceUsd: price.usd,
  });

  /*
   * The fee in wei, from the quote on screen, and it is the only argument the wallet
   * hook takes. The low-ETH warning compares a fee against a balance, both in wei, so
   * no ETH price is involved — which is the whole of what makes it able to fire at all.
   */
  const wallet = useWallet({ gasWei: quote.ngnQuote?.quote.gasWei ?? null });

  /*
   * `quote.ngnQuote?.quote` rather than the naira view: `useTrade` spends USDC base
   * units and encodes a floor in the token's own units, and neither of those has a
   * naira figure in it. The naira is the panel's business.
   */
  const trade = useTrade({
    quote: quote.ngnQuote?.quote ?? null,
    quoteExpired: quote.expired,
    refreshQuote: quote.refresh,
    wallet: wallet.state,
    owner: wallet.address,
  });

  return (
    <main className={styles.page}>
      <Link href="/markets" className={styles.back}>
        Back to markets
      </Link>

      <p className={styles.eyebrow}>{token.tokenSymbol}</p>
      <h1 className={styles.name}>{token.name}</h1>

      <p className={cx(styles.price, price.ngn === null && styles.priceMissing)}>
        {formatNGNAmount(price.ngn)}
      </p>

      {/* The age is stated, never dramatised: the reference feed publishes 24/5
          and the token trades 24/7, so a reading hours old is the ordinary Lagos
          afternoon rather than a fault. */}
      {price.unusable !== null ? (
        <p className={styles.note}>
          No reference price for this token yet, so we cannot show what a share
          is worth.
        </p>
      ) : age !== null ? (
        <p className={cx(styles.note, price.stale && styles.notice)}>
          Reference price {age}. The token itself keeps trading.
        </p>
      ) : null}

      <TradePanel
        token={token}
        amount={amount}
        onAmountChange={setAmount}
        ngn={ngn}
        usdToNgnRate={ngnRate}
        quote={quote}
        referenceAge={age}
        trade={trade}
      />

      <WalletConnect wallet={wallet} />

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.label}>Token contract</dt>
          <dd className={cx(styles.value, token.address === null && styles.muted)}>
            {token.address ?? "Not published yet"}
          </dd>
        </div>

        {/* Read from the registry, not from a live call. The figure was read off each
            contract by `npm run verify:chain` and recorded with that provenance, so a
            second multicall on page load would add a round trip and — worse — a window
            where this row and the share count above it disagreed. Null where the token
            has no published address, because there was no contract to read it from. */}
        <div className={styles.fact}>
          <dt className={styles.label}>On-chain decimals</dt>
          <dd
            className={cx(styles.value, token.decimals === null && styles.muted)}
          >
            {token.decimals ?? "No contract to read yet"}
          </dd>
        </div>

        <div className={styles.fact}>
          <dt className={styles.label}>Reference feed</dt>
          <dd className={styles.value}>{token.feedAddress}</dd>
        </div>
      </dl>
    </main>
  );
}
