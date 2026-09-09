/**
 * Brand marks, in the ported visual system's own classes.
 *
 * Presentational only. `Mark` is the real logo mark, recovered from the
 * reference repo's own history (`9d1970a^:repository-assets/bourse-logo-mark.png`,
 * removed there in favour of managed storage) — a client visual asset, never
 * server/shared code. `CompanyIcon` serves the six company SVGs from
 * `public/logos/`; META has no published mark, so it renders the approved
 * text badge in the same `company-badge` style.
 */

const LOGO_PATHS: Record<string, string> = {
  AAPL: "/logos/AAPL.svg",
  AMZN: "/logos/AMZN.svg",
  CRCL: "/logos/CRCL.svg",
  GOOGL: "/logos/GOOGL.svg",
  INTC: "/logos/INTC.svg",
  META: "/logos/META.svg",
  MSFT: "/logos/MSFT.svg",
  MSTR: "/logos/MSTR.svg",
  NVDA: "/logos/NVDA.svg",
  SPCX: "/logos/SPCX.svg",
  TSLA: "/logos/TSLA.svg",
};

/**
 * Badge grounds from the ported design for the original six; neutral
 * graphite for the marks added since, whose brand colors were never part
 * of the system. COIN and SNDK have no published mark and keep the letter
 * badge — the Coinbase wordmark is illegible at badge size, and inventing
 * or cropping brand art would be worse than an honest initial.
 */
const BADGE_COLORS: Record<string, string> = {
  AAPL: "#151617",
  AMZN: "#D18C32",
  GOOGL: "#5787BB",
  MSFT: "#4F6FCE",
  NVDA: "#73A85A",
  TSLA: "#C84340",
  META: "#5B5E62",
  MSTR: "#5B5E62",
  SPCX: "#5B5E62",
  CRCL: "#5B5E62",
  INTC: "#5B5E62",
};

/**
 * The logo file for a symbol, or null where no mark is published.
 *
 * Only the six SVGs in `public/logos/` exist; META, MSTR, SNDK and SPCX have
 * no published mark, so callers render a text badge instead of an `img` that
 * would 404. Never guess a logo URL — a wrong image is worse than a letter.
 */
export function logoPath(symbol: string): string | null {
  return LOGO_PATHS[symbol] ?? null;
}

export function Mark({ size = 30 }: { size?: number }) {
  return (
    <img
      className="brand-mark"
      src="/logo-mark.png"
      alt="Bourse"
      style={{ width: size, height: size }}
    />
  );
}

export function CompanyIcon({
  symbol,
  color,
}: {
  symbol: string;
  color?: string;
}) {
  const ground = color ?? BADGE_COLORS[symbol] ?? "#5B5E62";
  const logo = LOGO_PATHS[symbol];

  return (
    <div className="company-badge" style={{ background: ground }}>
      {logo === undefined ? (
        <span aria-hidden="true">{symbol.slice(0, 1)}</span>
      ) : (
        <img className="company-logo" src={logo} alt={`${symbol} logo`} />
      )}
    </div>
  );
}
