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
