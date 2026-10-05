import Card from "./Card.jsx";
import SkipLink from "./SkipLink.jsx";
import SiteFooter from "./SiteFooter.jsx";
import "./AuthShell.css";

/**
 * The frame every signed-out screen shares: the ink panel on the left,
 * the card on the right. Extracted at step 63, when four more screens
 * (verify-email, forgot-password, reset-password, and the states of
 * each) needed exactly what sign-in and register already had. Five
 * copies of this markup would have drifted the first time one of them
 * needed a landmark fixed.
 *
 * What it owns, so a screen using it cannot get them wrong: the skip
 * link, the `<main id="main" tabIndex={-1}>` it targets (a <main> is not
 * focusable by default, so without tabIndex the skip link would scroll
 * there without moving keyboard focus), and the single landmark
 * structure. What it does NOT own: the `<h1>`. Each screen supplies its
 * own, inside `children`, so there is exactly one per page (SRS §7.15).
 *
 * @param {{ children: import("react").ReactNode }} props
 */
export default function AuthShell({ children }) {
  return (
    <div className="cc-auth-page">
      <SkipLink />
      <div className="cc-auth-page__frame">
        {/* The ink half. Real content, so not aria-hidden; nothing in it
            is a heading, which keeps the card's h1 the page's only one. */}
        <aside className="cc-auth-panel">
          <div className="cc-auth-panel__brand">
            <span className="cc-auth-page__brand-mark" aria-hidden="true" />
            <span className="cc-auth-page__brand-name">ClauseCheck</span>
          </div>
          <p className="cc-auth-panel__statement">Know what you are signing.</p>
          <p className="cc-auth-panel__body">
            ClauseCheck reads a contract and points at the clauses that could cost you.
            Every clause it flags is quoted from your own file, so you can check it
            against the page.
          </p>
          <p className="cc-auth-panel__note">
            Your contracts are private to your account, and you can delete any of them
            permanently once you&apos;re done.
          </p>
        </aside>

        <main id="main" tabIndex={-1} className="cc-auth-page__main">
          <Card accent className="cc-auth-card">
            {children}
          </Card>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
