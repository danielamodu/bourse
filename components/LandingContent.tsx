"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Clock3,
  LineChart,
  ShieldCheck,
  Wallet,
} from "lucide-react";

import { useClock } from "@/hooks/useClock";
import { useNGNRate } from "@/hooks/useNGNRate";
import { formatFeedAge, formatNGNAmount } from "@/lib/format";
import { withMarketPrice, withNgnRate, type StockPrice } from "@/lib/price";
import {
  STOCK_LIST,
  type StockSymbol,
  type StockToken,
} from "@/lib/tokens";
import type { TradeabilityReports } from "@/lib/tradeability";

import { Mark } from "./Brand";
import CookieConsent from "./CookieConsent";
import { NairaAmount } from "./NairaAmount";
import { StockCard } from "./StockCard";

/**
 * The landing page on the ported visual: hero, ticker, story, market
 * preview, trust, ownership, journey, closing and footer.
 *
 * Static copy and layout are the reference design's. Every number is ours:
 * the ticker and the preview cards read the same server probe the markets
 * page does, and the trust terminal states a reference price with its age
 * rather than a portfolio value nobody holds. Connect actions link to sign-in
 * instead of opening a wallet modal — this page ships no wallet stack, and
 * browsing comes before connecting.
 */
export function LandingContent({
  prices,
  reports,
  readAtMs,
}: {
  prices: Record<StockSymbol, StockPrice>;
  reports: TradeabilityReports;
  readAtMs: number;
}) {
  const { rate } = useNGNRate();
  const nowMs = useClock(readAtMs);
  const [saved, setSaved] = useState<ReadonlySet<StockSymbol>>(new Set());

  const toggleSaved = (symbol: StockSymbol) => {
    setSaved((previous) => {
      const next = new Set(previous);
      if (next.has(symbol)) {
        next.delete(symbol);
      } else {
        next.add(symbol);
      }
      return next;
    });
  };

  const tradeable = STOCK_LIST.filter(
    (token) => reports[token.symbol].verdict === "tradeable",
  );
  const priced = (token: StockToken) =>
    withMarketPrice(
      withNgnRate(prices[token.symbol], rate),
      reports[token.symbol].usdPerShare,
    );

  const featured =
    tradeable[0] ??
    STOCK_LIST.find((token) => prices[token.symbol].unusable === null) ??
    null;
  const featuredAge =
    featured === null ? null : formatFeedAge(prices[featured.symbol].updatedAt, nowMs);

  const ticker = tradeable.length > 0 ? [...tradeable, ...tradeable, ...tradeable] : [];

  return (
    <div className="landing">
      <header className="site-header">
        <Link href="/" className="brand-lockup">
          <Mark size={32} />
          <span>bourse</span>
        </Link>
        <nav className="site-nav" aria-label="Sections">
          <a href="#how-it-works">How it works</a>
          <a href="#market-preview">Markets</a>
          <a href="#trust">Trust</a>
        </nav>
        <div className="header-actions">
          <Link href="/login" className="header-login">
            Sign in
          </Link>
          <Link href="/login" className="button button-dark button-small">
            Connect wallet <ArrowRight size={15} />
          </Link>
        </div>
      </header>

      <main>
        <section className="hero" style={{ backgroundImage: "url(/hero.webp)" }}>
          <div className="hero-wash" />
          <div className="hero-content">
            <div className="eyebrow">
              <span className="eyebrow-dot" /> NAIRA → GLOBAL OWNERSHIP
            </div>
            <h1>
              Own a piece
              <br />
              of what’s next.
            </h1>
            <p>
              Buy US tokenized stocks with naira, directly from your wallet. No
              dollar account required.
            </p>
            <div className="hero-actions">
              <Link href="/markets" className="button button-dark">
                Explore markets <ArrowUpRight size={17} />
              </Link>
              <a className="text-link" href="#how-it-works">
                See how it works <ArrowRight size={15} />
              </a>
            </div>
          </div>
          <div className="hero-note">
            <span>Built on Base</span>
            <span className="note-divider" />
            <span>Powered by tokenized stocks</span>
          </div>
        </section>

        {ticker.length > 0 ? (
          <section className="ticker-strip" aria-label="Live market prices">
            <div className="ticker-viewport">
              <div className="ticker-track">
                {ticker.map((stock, index) => {
                  const price = priced(stock);
                  return (
                    <div
                      className="ticker-item"
                      key={`${stock.symbol}-${index}`}
                    >
                      {stock.symbol === "META" ? null : (
                        <img
                          className="ticker-logo"
                          src={`/logos/${stock.symbol}.svg`}
                          alt=""
                        />
                      )}
                      <span>{stock.tokenSymbol}</span>
                      <strong>
                        <NairaAmount
                          value={formatNGNAmount(price.ngn)}
                          rate={rate}
                        >
                          {formatNGNAmount(price.ngn)}
                        </NairaAmount>
                      </strong>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        ) : null}

        <section className="story-section" id="how-it-works">
          <div className="section-intro">
            <div className="eyebrow">HOW IT WORKS</div>
            <h2>
              From naira
              <br />
              <em>to ownership.</em>
            </h2>
            <p>
              A simpler way to access the companies shaping the world. Fund
              once, trade in a few taps, and keep your portfolio in view.
            </p>
          </div>
          <div className="steps">
            <div className="step">
              <span className="step-number">01</span>
              <div className="step-icon">
                <Wallet size={21} />
              </div>
              <h3>Fund</h3>
              <p>Add naira through a trusted onramp and receive USDC in your wallet.</p>
              <ArrowRight className="step-arrow" size={18} />
            </div>
            <div className="step step-featured">
              <span className="step-number">02</span>
              <div className="step-icon">
                <LineChart size={21} />
              </div>
              <h3>Trade</h3>
              <p>Choose from a growing list of tokenized US stocks priced clearly in naira.</p>
              <ArrowRight className="step-arrow" size={18} />
            </div>
            <div className="step">
              <span className="step-number">03</span>
              <div className="step-icon">
                <ArrowDownRight size={21} />
              </div>
              <h3>Withdraw</h3>
              <p>Sell when you’re ready and move your money back to your bank account.</p>
              <ArrowRight className="step-arrow" size={18} />
            </div>
          </div>
        </section>

        <section className="market-preview" id="market-preview">
          <div className="section-heading">
            <div>
              <div className="eyebrow">THE MARKET</div>
              <h2>
                Companies you know.
                <br />
                <em>Access you didn’t have.</em>
              </h2>
            </div>
            <Link href="/markets" className="button button-outline">
              View all markets <ArrowRight size={15} />
            </Link>
          </div>
          <div className="stock-grid">
            {tradeable.slice(0, 4).map((stock, i) => (
              <StockCard
                key={stock.symbol}
                token={stock}
                price={priced(stock)}
                tradeability={reports[stock.symbol].verdict}
                rate={rate}
                index={i}
                nowMs={nowMs}
                saved={saved.has(stock.symbol)}
                onToggleSaved={() => toggleSaved(stock.symbol)}
              />
            ))}
          </div>
        </section>

        <section className="trust-section" id="trust">
          <div className="trust-panel">
            <div className="eyebrow">DESIGNED FOR CONFIDENCE</div>
            <h2>
              Clarity is a<br />
              <em>feature.</em>
            </h2>
            <p>
              Every quote, fee, balance, and transaction is shown in plain
              language. Bourse is built for people who want to understand their
              money, not decode a terminal.
            </p>
            <div className="trust-stats">
              <div>
                <strong>₦ </strong>
                <span>Every price in naira</span>
              </div>
              <div>
                <ShieldCheck size={23} />
                <span>Built on Base</span>
              </div>
              <div>
                <Clock3 size={23} />
                <span>Clear quote timing</span>
              </div>
            </div>
          </div>
          <div
            className="trust-art"
            style={{ backgroundImage: "url(/data-texture.webp)" }}
          >
            <div className="mini-terminal">
              <div className="terminal-top">
                <span>
                  {featured === null
                    ? "REFERENCE PRICE"
                    : `${featured.symbol} · REFERENCE PRICE`}
                </span>
                <span className="terminal-live">
                  <i /> FEEDS UPDATE 24/5
                </span>
              </div>
              <strong>
                {featured === null ? (
                  "—"
                ) : (
                  <NairaAmount
                    value={formatNGNAmount(prices[featured.symbol].ngn)}
                    rate={rate}
                  >
                    {formatNGNAmount(prices[featured.symbol].ngn)}
                  </NairaAmount>
                )}
              </strong>
              <em>
                {featuredAge === null
                  ? "No reference price yet"
                  : `Reference ${featuredAge}`}
              </em>
            </div>
          </div>
        </section>

        <section className="ownership-section">
          <div className="ownership-copy">
            <div className="eyebrow">A DIFFERENT KIND OF ACCESS</div>
            <h2>
              Global companies.
              <br />
              <em>Local currency.</em>
            </h2>
            <p>
              You shouldn’t need a dollar account or a finance degree to own
              the companies you believe in. Bourse turns the distance between
              here and there into a few clear steps.
            </p>
            <div className="ownership-list">
              <div>
                <strong>01</strong>
                <span>See the price in naira</span>
              </div>
              <div>
                <strong>02</strong>
                <span>Choose how much to invest</span>
              </div>
              <div>
                <strong>03</strong>
                <span>Keep it in your portfolio</span>
              </div>
            </div>
          </div>
          <div className="ownership-card">
            <div className="ownership-card-top">
              <span>YOUR NEXT MOVE</span>
              <span>BOURSE / 01</span>
            </div>
            <div className="ownership-orbit">
              <div className="orbit-line orbit-one" />
              <div className="orbit-line orbit-two" />
              <div className="orbit-center">
                <span>₦</span>
                <strong>•</strong>
              </div>
              <div className="orbit-node node-a">
                <img src="/logos/AAPL.svg" alt="Apple logo" />
                <span>AAPL</span>
              </div>
              <div className="orbit-node node-b">
                <img src="/logos/TSLA.svg" alt="Tesla logo" />
                <span>TSLA</span>
              </div>
              <div className="orbit-node node-c">
                <img src="/logos/MSFT.svg" alt="Microsoft logo" />
                <span>MSFT</span>
              </div>
            </div>
            <p>One wallet. A world of ownership.</p>
          </div>
        </section>

        <section className="journey-section">
          <div className="journey-heading">
            <div className="eyebrow">THE BOURSE JOURNEY</div>
            <h2>
              Simple by design.
              <br />
              <em>Clear by default.</em>
            </h2>
          </div>
          <div className="journey-steps">
            <div>
              <span>01</span>
              <strong>Connect</strong>
              <p>Bring the wallet you already trust.</p>
            </div>
            <div>
              <span>02</span>
              <strong>Fund</strong>
              <p>Move naira into USDC through a secure onramp.</p>
            </div>
            <div>
              <span>03</span>
              <strong>Own</strong>
              <p>Buy fractional tokenized shares and track them in one place.</p>
            </div>
            <div>
              <span>04</span>
              <strong>Return</strong>
              <p>Sell and withdraw back to your bank when it suits you.</p>
            </div>
          </div>
        </section>

      </main>

      <footer className="editorial-footer">
        <section className="editorial-cta">
          <div className="eyebrow">YOUR NEXT MOVE</div>
          <h2>
            Global access.
            <br />
            <em>Local clarity.</em>
          </h2>
          <p>
            Own the companies shaping tomorrow, with every price and every step
            made clear in naira.
          </p>
          <div className="editorial-cta-actions">
            <Link href="/login" className="button button-dark">
              Connect wallet <ArrowUpRight size={17} />
            </Link>
            <Link href="/docs" className="text-link">
              Read the docs <ArrowRight size={15} />
            </Link>
          </div>
        </section>
        <div className="editorial-footer-main">
          <div className="editorial-brand">
            <div className="brand-lockup">
              <Mark size={34} />
              <span>bourse</span>
            </div>
            <p>
              Global ownership,
              <br />
              priced in naira.
            </p>
            <span className="editorial-copyright">© 2026 Bourse</span>
          </div>
          <div className="editorial-links">
            <div className="footer-column">
              <div className="footer-heading">PRODUCT</div>
              <a href="#market-preview">Markets</a>
              <a href="#how-it-works">How it works</a>
              <a href="#trust">Security</a>
            </div>
            <div className="footer-column">
              <div className="footer-heading">COMPANY</div>
              <a href="#trust">About Bourse</a>
              <a href="#trust">For partners</a>
              <a href="#trust">Contact</a>
            </div>
            <div className="footer-column">
              <div className="footer-heading">RESOURCES</div>
              <Link href="/docs">Docs</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
            </div>
          </div>
          <div className="editorial-status">
            <span>
              <i /> All systems operational
            </span>
            <span>Built on Base · Powered by tokenized stocks</span>
          </div>
        </div>
        <div
          className="editorial-city-art"
          role="img"
          aria-label="City skyline"
          style={{ backgroundImage: "url(/footer-city.webp)" }}
        />
        <div className="editorial-footer-bottom">
          <span>
            Tokenized stocks involve risk. This is not financial advice.
          </span>
          <div className="footer-links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </div>
        </div>
      </footer>

      <CookieConsent />
    </div>
  );
}
