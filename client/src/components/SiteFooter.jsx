import { Link } from "react-router";
import "./SiteFooter.css";

/**
 * BUILD-PLAN step 74 / PRD §12: the legal surface, linked from every
 * screen: the signed-in ones (App.jsx's Protected), the signed-out ones
 * (AuthShell), and the legal pages themselves. The upload screen links
 * the privacy policy and terms again where a file is handed over, which
 * is the moment they matter most.
 *
 * Security points at the published security.txt (NFR-2.13), served from
 * the site root by the static host, so it is a plain link, not a route.
 */
export default function SiteFooter() {
  return (
    <footer className="cc-site-footer">
      <nav className="cc-site-footer__nav" aria-label="Legal">
        <ul className="cc-site-footer__links">
          <li>
            <Link to="/privacy">Privacy policy</Link>
          </li>
          <li>
            <Link to="/terms">Terms of service</Link>
          </li>
          <li>
            <Link to="/subprocessors">Subprocessors</Link>
          </li>
          <li>
            <a href="/.well-known/security.txt">Report a security issue</a>
          </li>
        </ul>
      </nav>
      <p className="cc-site-footer__note">
        ClauseCheck is not a law firm and does not give legal advice.
      </p>
    </footer>
  );
}
