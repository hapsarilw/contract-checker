import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * After a client-side navigation, put keyboard focus back at the top of
 * the document, the way a full page load does, so the next Tab reaches the
 * skip link first (SRS §7.15, WCAG 2.4.3 focus order).
 *
 * WHY THIS EXISTS (step 74). A route change unmounts the element that had
 * focus (the "Create account" button, say). Browsers then continue the Tab
 * order from where that element USED to be. Before step 74 nothing came
 * after the page content, so Tab wrapped to the top and the skip link, by
 * luck. The legal footer put links there, and the keyboard journey test
 * caught a newly signed-up keyboard user landing on "Privacy policy" at the
 * bottom of the new page.
 *
 * Only when focus was LOST (it is on <body>): a page that deliberately
 * moves focus on arrival, or an open dialog, keeps it.
 */
export default function FocusOnNavigate() {
  const { pathname } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const body = document.body;
    // <body> is focusable only with a tabindex; it is removed again as soon
    // as focus moves on, so it never becomes a Tab stop.
    body.setAttribute("tabindex", "-1");
    body.focus({ preventScroll: true });
    body.addEventListener("blur", () => body.removeAttribute("tabindex"), { once: true });
  }, [pathname]);

  return null;
}
