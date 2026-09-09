import type { ReactNode } from "react";

/**
 * A naira figure with its dollar equivalent on hover/focus, in the ported
 * `naira-tooltip` style.
 *
 * The rate is a prop and always ours (`/api/ngn-rate` via `useStockPrices`) —
 * never the hardcoded figure the reference design carried. Without a rate
 * there is no tooltip, because a conversion against a number we do not have
 * would be invented.
 */
export function NairaAmount({
  value,
  rate,
  children,
}: {
  value: string | number;
  rate: number | null;
  children?: ReactNode;
}) {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) {
    return <span>{children ?? value}</span>;
  }

  const numericValue =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[^0-9.]/g, ""));
  const usdValue = Number.isFinite(numericValue) ? numericValue / rate : 0;
  const label = `≈ $${usdValue.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USD · rate ₦${rate.toLocaleString("en-US")} / $1`;

  return (
    <span
      className="naira-tooltip"
      tabIndex={0}
      data-tooltip={label}
      aria-label={`${children ?? value}. ${label}`}
    >
      {children ?? value}
    </span>
  );
}
