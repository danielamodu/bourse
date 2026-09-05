/**
 * USDC, as far as a buy needs it: read the allowance, set the allowance.
 *
 * Two functions and no more. A full ERC-20 ABI here would put `transfer` and
 * `transferFrom` within reach of anything that imports this file, and nothing in
 * Bourse moves a user's USDC itself — the router does, under an allowance the user
 * signed for. Keeping the ABI to what we call is the cheapest way to make that true
 * by construction rather than by review.
 *
 * The `spender` is never a value from a response. It is
 * `KYBERSWAP_ROUTER_ADDRESS`, the pinned constant, passed at the call site in
 * `hooks/useTrade.ts`.
 */
export const usdcAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Chainlink AggregatorV3Interface — only the two functions we call.
 *
 * `decimals()` is read rather than assumed. The Coinbase tokenized equity feeds
 * happen to use 8, but that is a property of each feed contract, not a
 * guarantee, and a wrong assumption here silently misprices every card.
 */
export const aggregatorV3Abi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
