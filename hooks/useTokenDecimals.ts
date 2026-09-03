"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import { erc20Abi } from "viem";
import { useReadContracts } from "wagmi";
import { base } from "wagmi/chains";

import { assertValidTokenAddress, isValidTokenAddress } from "@/lib/address";
import { STOCK_LIST, type StockSymbol } from "@/lib/tokens";

/**
 * On-chain `decimals()` for every token we have an address for.
 *
 * B20 precision is configurable and is not 18. Nothing may assume a value —
 * order sizing and balance formatting both derive from this read, so a wrong
 * assumption here misprices trades silently rather than failing loudly.
 *
 * Every address is shape-checked before it becomes a read. Counterfeit tokenized
 * stocks are live on Base, so an address that does not sit in the `0xb2…`
 * precompile range must stop the read rather than be quietly attempted.
 */

const TOKENS_WITH_ADDRESS = STOCK_LIST.filter(
  (token): token is (typeof STOCK_LIST)[number] & { address: Address } =>
    isValidTokenAddress(token.address),
);

const DECIMALS_CONTRACTS = TOKENS_WITH_ADDRESS.map(
  (token) =>
    ({
      address: assertValidTokenAddress(
        token.address,
        `useTokenDecimals(${token.symbol})`,
      ),
      abi: erc20Abi,
      functionName: "decimals",
      chainId: base.id,
    }) as const,
);

export type TokenDecimals = {
  /** Absent for any token whose read has not landed or has failed. */
  decimals: Partial<Record<StockSymbol, number>>;
  loading: boolean;
  error: Error | null;
};

export function useTokenDecimals(): TokenDecimals {
  const { data, isLoading, error, dataUpdatedAt } = useReadContracts({
    contracts: DECIMALS_CONTRACTS,
    allowFailure: true,
    query: {
      enabled: DECIMALS_CONTRACTS.length > 0,
      // Precision is fixed at deploy time; there is nothing to poll for.
      staleTime: Number.POSITIVE_INFINITY,
    },
  });

  const decimals = useMemo(() => {
    const result: Partial<Record<StockSymbol, number>> = {};

    TOKENS_WITH_ADDRESS.forEach((token, index) => {
      const read = data?.[index];
      if (read?.status === "success" && typeof read.result === "number") {
        result[token.symbol] = read.result;
      }
    });

    return result;
    // dataUpdatedAt changes whenever the multicall resolves.
  }, [data, dataUpdatedAt]);

  return { decimals, loading: isLoading, error: error ?? null };
}
