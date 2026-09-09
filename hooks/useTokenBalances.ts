"use client";

import { useMemo } from "react";
import { erc20Abi, type Address } from "viem";
import { useReadContracts } from "wagmi";

import { BASE_CHAIN_ID } from "@/lib/rpc";
import {
  QUOTABLE_SYMBOLS,
  TOKEN_ADDRESSES,
  type QuotableSymbol,
} from "@/lib/tokens";

/**
 * Token quantities for the four published tokens, read off each contract.
 *
 * Raw quantities only — no naira, no gains, no cost basis. Naira valuation
 * needs a price the portfolio joins on screen and labels approximate,
 * because the balance-to-price multiplier is unconfirmed until the first
 * funded buy. P&L is not derived here at all.
 */
export function useTokenBalances(owner: string | null): {
  balances: Record<QuotableSymbol, bigint | null>;
  loading: boolean;
  refetch: () => void;
} {
  const sender = useMemo(
    () =>
      owner === null || !/^0x[0-9a-fA-F]{40}$/.test(owner)
        ? null
        : (owner as Address),
    [owner],
  );

  const { data, isLoading, refetch } = useReadContracts({
    contracts: QUOTABLE_SYMBOLS.map(
      (symbol) =>
        ({
          address: TOKEN_ADDRESSES[symbol],
          abi: erc20Abi,
          functionName: "balanceOf",
          args: sender === null ? undefined : ([sender] as const),
          chainId: BASE_CHAIN_ID,
        }) as const,
    ),
    query: { enabled: sender !== null },
  });

  const balances = useMemo(() => {
    const entries = QUOTABLE_SYMBOLS.map((symbol, index) => {
      const result = data?.[index];
      return [
        symbol,
        result?.status === "success" &&
        typeof result.result === "bigint"
          ? result.result
          : null,
      ] as const;
    });
    return Object.fromEntries(entries) as Record<QuotableSymbol, bigint | null>;
  }, [data]);

  return {
    balances,
    loading: isLoading && sender !== null,
    refetch: () => {
      void refetch();
    },
  };
}
