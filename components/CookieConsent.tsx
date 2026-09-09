/* Consent UI is quiet, direct, and never competes with the product. */
"use client";

import { useEffect, useState } from "react";
import { Cookie, X } from "lucide-react";

const CONSENT_KEY = "bourse-cookie-consent";

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      setVisible(window.localStorage.getItem(CONSENT_KEY) === null);
    } catch {
      setVisible(true);
    }
  }, []);

  const decide = (value: "accepted" | "declined") => {
    try {
      window.localStorage.setItem(CONSENT_KEY, value);
    } catch {
      // The banner can still dismiss if storage is unavailable.
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <aside className="cookie-consent" aria-label="Cookie consent">
      <div className="cookie-copy">
        <span className="cookie-icon">
          <Cookie size={17} />
        </span>
        <div>
          <strong>Cookies, kept simple.</strong>
          <p>
            We use essential cookies to keep Bourse reliable and optional
            analytics cookies to understand what needs improving.
          </p>
        </div>
      </div>
      <div className="cookie-actions">
        <button className="cookie-decline" onClick={() => decide("declined")}>
          Decline
        </button>
        <button className="cookie-accept" onClick={() => decide("accepted")}>
          Accept
        </button>
      </div>
      <button
        className="cookie-close"
        aria-label="Close cookie notice"
        onClick={() => decide("declined")}
      >
        <X size={15} />
      </button>
    </aside>
  );
}
