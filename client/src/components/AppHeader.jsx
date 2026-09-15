import { Link, useLocation } from "react-router";
import { useAuth } from "../auth/useAuth.js";
import { useI18n } from "../i18n/useI18n.js";
import "./AppHeader.css";

/**
 * BUILD-PLAN step 39 — the prototype's app chrome
 * (docs/design/ClauseCheck.html: the dark header, "New contract" /
 * "History" / "Sign out"), shown on every screen except the prototype's
 * own `showAppChrome: s.screen !== 'auth'` exception — the real app's
 * equivalent is App.jsx only mounting this on the four protected
 * routes, never on /login, /register, or the three placeholder auth
 * routes (verify-email, forgot-password, reset-password).
 *
 * "New contract" and "History" are real `<Link>`s (not the prototype's
 * onClick-driven buttons — there was no router underneath it to link
 * to), each marked `aria-current="page"` when active, matching the
 * prototype's `tabUpload`/`tabHist` active-state colouring one-for-one.
 * "History" stays current for `/documents/:id` too: opening a report
 * is still part of the history flow, not a third destination of its
 * own.
 *
 * "Sign out" is deliberately a `<button>`, as in the prototype: it
 * performs an action (AuthProvider's signOut, which calls
 * POST /api/v1/auth/logout — FR-7.7/FR-1.9), not a navigation. Once it
 * resolves, `status` flips to "unauthenticated" and every RequireAuth
 * on the page tree redirects to /login on its own — this button does
 * not navigate itself.
 */
export default function AppHeader() {
  const location = useLocation();
  const { signOut } = useAuth();
  const { t } = useI18n();

  const isUpload = location.pathname === "/";
  const isHistory = location.pathname.startsWith("/documents");

  return (
    <header className="cc-app-header">
      <div className="cc-app-header__inner">
        <div className="cc-app-header__brand">
          <span className="cc-app-header__brand-mark" aria-hidden="true" />
          <span className="cc-app-header__brand-name">ClauseCheck</span>
        </div>
        <nav className="cc-app-header__nav" aria-label="Primary">
          <Link
            to="/"
            aria-current={isUpload ? "page" : undefined}
            className={`cc-app-header__link ${isUpload ? "cc-app-header__link--active" : ""}`.trim()}
          >
            {t.navNew}
          </Link>
          <Link
            to="/documents"
            aria-current={isHistory ? "page" : undefined}
            className={`cc-app-header__link ${isHistory ? "cc-app-header__link--active" : ""}`.trim()}
          >
            {t.navHistory}
          </Link>
          <button
            type="button"
            className="cc-app-header__link cc-app-header__sign-out"
            onClick={() => signOut()}
          >
            {t.navSignOut}
          </button>
        </nav>
      </div>
    </header>
  );
}
