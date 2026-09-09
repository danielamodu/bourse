import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";

import { AppShell } from "@/components/AppShell";

/**
 * Funding shell: the ported layout with a coming-soon note where the
 * converter will live. No amount field and no converted figure — both would
 * promise a flow that does not exist yet.
 */
export default function FundingPage() {
  return (
    <AppShell walletAddress={null}>
      <div className="page-header">
        <div>
          <div className="eyebrow">FUNDING / ₦ ↔ USDC</div>
          <h1>Move money, simply.</h1>
          <p>Fund your wallet in naira or withdraw when you’re ready.</p>
        </div>
      </div>

      <div className="funding-layout">
        <div className="funding-main">
          <div className="funding-card">
            <div className="eyebrow">COMING SOON</div>
            <p className="trade-note" style={{ marginTop: 14 }}>
              Funding in naira is coming soon. You will be able to move money
              in and back out from this screen.
            </p>
            <p style={{ marginTop: 24 }}>
              <Link href="/markets" className="button button-dark full-width">
                Browse markets <ArrowRight size={16} />
              </Link>
            </p>
            <p className="fine-print">
              <ShieldCheck size={14} /> Securely handled by your connected
              payment provider.
            </p>
          </div>
        </div>
        <aside className="funding-aside">
          <div className="eyebrow">YOUR BALANCE</div>
          <p style={{ marginTop: 16 }}>
            Connect a wallet to see your balance.{" "}
            <Link href="/login" className="text-link">
              Connect <ArrowRight size={14} />
            </Link>
          </p>
          <div className="aside-divider" />
          <p>
            Funds are held in your connected wallet. You can trade whenever
            markets are open.
          </p>
        </aside>
      </div>
    </AppShell>
  );
}
