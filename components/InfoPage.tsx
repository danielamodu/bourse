import Link from "next/link";
import { ArrowLeft, ArrowRight, BookOpen, LockKeyhole, Scale } from "lucide-react";

import { Mark } from "./Brand";

export type InfoKind = "docs" | "privacy" | "terms";

/**
 * Docs, privacy and terms on the ported `info-page` visual, with the
 * reference copy verbatim — including its own working-draft notice, which
 * stays until counsel reviews it.
 */
const pageData: Record<
  InfoKind,
  {
    eyebrow: string;
    title: string;
    intro: string;
    icon: typeof BookOpen;
    sections: { title: string; body: string }[];
  }
> = {
  docs: {
    eyebrow: "BOURSE / DOCUMENTATION",
    title: "Everything you need to move with clarity.",
    intro:
      "A short guide to how Bourse works, from connecting a wallet to owning tokenized US stocks in naira.",
    icon: BookOpen,
    sections: [
      {
        title: "Connect your wallet",
        body: "Your wallet is your account on Bourse. Connect a supported wallet to view markets, fund your account, and manage your ownership. Bourse does not ask for or store your private keys.",
      },
      {
        title: "Fund with naira",
        body: "Use a supported funding provider to move naira into the flow and receive the digital dollars required to trade. You will see the applicable quote, fees, and timing before confirming.",
      },
      {
        title: "Trade tokenized stocks",
        body: "Browse available companies, review the live naira quote, choose an amount, and review the full order summary before signing in your wallet. Prices can move and tokenized assets carry risk.",
      },
      {
        title: "Keep your portfolio in view",
        body: "Track holdings, performance, activity, and available balance from the Bourse app shell. The information shown is for product use and is not financial advice.",
      },
    ],
  },
  privacy: {
    eyebrow: "BOURSE / PRIVACY",
    title: "Your wallet stays yours.",
    intro:
      "This working privacy notice explains the information Bourse may process while you explore and use the product.",
    icon: LockKeyhole,
    sections: [
      {
        title: "Information we may process",
        body: "Depending on the feature, Bourse may process wallet addresses, connection events, device and browser information, product preferences, support messages, and transaction-related information needed to provide the service.",
      },
      {
        title: "Why we use it",
        body: "We use this information to operate the product, show your portfolio, improve reliability, prevent abuse, provide support, meet applicable obligations, and communicate important service updates.",
      },
      {
        title: "What we do not collect",
        body: "Bourse is designed so that we do not receive or store your wallet seed phrase or private keys. Never share either with anyone claiming to represent Bourse.",
      },
      {
        title: "Your choices",
        body: "You can disconnect a wallet, request support, or ask questions about information associated with your use of the product by contacting the Bourse team through the approved support channel.",
      },
    ],
  },
  terms: {
    eyebrow: "BOURSE / TERMS",
    title: "Clear terms for a clearer market.",
    intro:
      "These working terms describe the basic rules for using the Bourse product and should be reviewed by qualified counsel before production use.",
    icon: Scale,
    sections: [
      {
        title: "The service",
        body: "Bourse provides an interface for exploring and interacting with supported tokenized assets and related funding flows. Availability, supported assets, providers, and features may change.",
      },
      {
        title: "Your responsibilities",
        body: "You are responsible for your wallet, access credentials, device security, transaction confirmations, and ensuring that your use of the service is permitted where you live.",
      },
      {
        title: "Risk disclosure",
        body: "Tokenized stocks, digital assets, currencies, and related transactions involve risk, including price volatility, liquidity risk, technology risk, counterparty risk, and regulatory change. You can lose money.",
      },
      {
        title: "No financial advice",
        body: "Bourse does not provide individualized investment, tax, or legal advice. Information shown in the product is not a recommendation to buy, sell, or hold any asset.",
      },
    ],
  },
};

export function InfoPage({ kind }: { kind: InfoKind }) {
  const data = pageData[kind];
  const Icon = data.icon;

  return (
    <div className="info-page">
      <header className="info-header">
        <Link href="/" className="brand-lockup">
          <Mark size={32} />
          <span>bourse</span>
        </Link>
        <Link href="/" className="info-back">
          <ArrowLeft size={15} /> Back to Bourse
        </Link>
      </header>
      <main className="info-main">
        <div className="info-hero">
          <div className="eyebrow">
            <Icon size={14} /> {data.eyebrow}
          </div>
          <h1>{data.title}</h1>
          <p>{data.intro}</p>
        </div>
        <div className="info-body">
          <aside className="info-index">
            <span>ON THIS PAGE</span>
            <a href="#overview">Overview</a>
            {data.sections.map((section) => (
              <a
                key={section.title}
                href={`#${section.title.toLowerCase().replaceAll(" ", "-")}`}
              >
                {section.title}
              </a>
            ))}
          </aside>
          <div className="info-sections" id="overview">
            {data.sections.map((section, index) => (
              <section
                className="info-section"
                id={section.title.toLowerCase().replaceAll(" ", "-")}
                key={section.title}
              >
                <span className="info-number">0{index + 1}</span>
                <div>
                  <h2>{section.title}</h2>
                  <p>{section.body}</p>
                </div>
              </section>
            ))}
            <div className="info-note">
              <strong>Working draft.</strong> This page is product copy for the
              prototype. Have qualified legal counsel review the Privacy and
              Terms content before relying on it in production.
            </div>
          </div>
        </div>
      </main>
      <footer className="info-footer">
        <span>© 2026 Bourse</span>
        <div>
          <Link href="/docs">Docs</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </div>
        <Link href="/login" className="info-cta">
          Connect wallet <ArrowRight size={15} />
        </Link>
      </footer>
    </div>
  );
}
