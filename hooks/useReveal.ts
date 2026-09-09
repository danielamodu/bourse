"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scroll reveal for one element: hidden until it first enters the viewport,
 * then shown once and left alone.
 *
 * The hidden state lives behind the `reveal-on` class this adds to
 * `documentElement` — without JS that class never lands, so server HTML and
 * no-JS renders stay fully visible and nothing can strand content at
 * `opacity: 0`. With JS but no IntersectionObserver (old contexts), the
 * element shows immediately for the same reason.
 *
 * Once means once: re-hiding on scroll-out would punish slow readers by
 * replaying entrances, and an entrance that replays is decoration rather
 * than orientation. Pair with `.reveal` / `.is-visible` in design.css, and
 * an inline `--reveal-delay` for stagger (grids use index × 60ms).
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("reveal-on");

    const element = ref.current;
    if (element === null) return;

    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -10% 0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, visible };
}

/**
 * Merges the reveal state onto an existing class list: `reveal` always (so
 * the no-JS render matches), `is-visible` once the observer fires.
 */
export function revealClass(visible: boolean, className: string): string {
  return visible ? `reveal is-visible ${className}` : `reveal ${className}`;
}
