import { AppShell } from "@/components/AppShell";

/**
 * History shell. Transaction history is out of scope for v1, so this states
 * that plainly in the ported empty-state style rather than showing rows
 * nobody holds.
 */
export default function HistoryPage() {
  return (
    <AppShell walletAddress={null}>
      <div className="page-header">
        <div>
          <div className="eyebrow">HISTORY / ACTIVITY</div>
          <h1>Everything accounted for.</h1>
          <p>A clear record of your Bourse activity.</p>
        </div>
      </div>

      <div className="empty-state">
        <h3>Transaction history is not available yet</h3>
        <p>
          Until then, every purchase links out to Basescan from the trade
          panel, so nothing you sign goes unverified.
        </p>
      </div>
    </AppShell>
  );
}
