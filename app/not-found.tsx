import Link from "next/link";
import { ArrowRight } from "lucide-react";

/** Unknown route, in the editorial voice: no terminal styling, no new deps. */
export default function NotFound() {
  return (
    <div className="info-page">
      <main className="info-main">
        <div className="info-hero">
          <div className="eyebrow">404</div>
          <h1>This page is not there.</h1>
          <p>
            It may have moved, or you followed a link that never existed.
            Markets are a safer bet.
          </p>
          <p style={{ marginTop: 28 }}>
            <Link href="/markets" className="button button-dark">
              Back to markets <ArrowRight size={15} />
            </Link>
          </p>
        </div>
      </main>
      <footer className="info-footer">
        <span>© 2026 Bourse</span>
      </footer>
    </div>
  );
}
