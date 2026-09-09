import { notFound } from "next/navigation";

import { findStock, isQuotableSymbol } from "@/lib/tokens";

import { TradeDetail } from "./TradeDetail";

/** Next 15 hands route params to the page as a promise. */
type TradePageProps = {
  params: Promise<{ symbol: string }>;
};

export default async function TradePage({ params }: TradePageProps) {
  const { symbol } = await params;
  const token = findStock(symbol);

  // Unknown ticker: a 404 is the honest answer, not an empty market page.
  if (token === null) notFound();

  // A token with no published address must never reach the trade panel: there
  // is nothing to quote against, so there is nothing to buy. The markets page
  // shows its reference price instead.
  if (!isQuotableSymbol(token.symbol)) notFound();

  return <TradeDetail symbol={token.symbol} />;
}
