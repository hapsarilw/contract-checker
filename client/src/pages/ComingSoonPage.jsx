import { Link } from "react-router";
import SkipLink from "../components/SkipLink.jsx";
import "./ComingSoonPage.css";

/**
 * BUILD-PLAN step 39 — "add placeholder routes now that render a
 * 'coming soon' panel, so the guard logic is written once." Backs the
 * four FR-7.1 routes step 63 builds for real: /verify-email,
 * /forgot-password, /reset-password, /settings. One component, not
 * four, since the only thing that differs between them is copy.
 *
 * @param {{
 *   title: string,
 *   body: string,
 *   backTo: string,
 *   backLabel: string,
 * }} props
 */
export default function ComingSoonPage({ title, body, backTo, backLabel }) {
  return (
    <div className="cc-coming-soon">
      <SkipLink />
      <main id="main" tabIndex={-1}>
        <div className="cc-coming-soon__card">
          <h1 className="cc-coming-soon__title">{title}</h1>
          <p className="cc-coming-soon__body">{body}</p>
          <Link to={backTo} className="cc-coming-soon__back">
            {backLabel}
          </Link>
        </div>
      </main>
    </div>
  );
}
