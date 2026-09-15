import { Link } from "react-router";
import SkipLink from "../components/SkipLink.jsx";
import "./NotFoundPage.css";

/**
 * BUILD-PLAN step 39 — "A 404 route in the prototype's visual
 * language." The prototype has no 404 screen of its own (a fixed-state
 * demo has nothing to 404 on), so "the prototype's visual language"
 * means this reads as one of its screens would — the same card, the
 * same type, the same brand-green primary action — not a literal
 * screen it never drew.
 */
export default function NotFoundPage() {
  return (
    <div className="cc-not-found">
      <SkipLink />
      <main id="main" tabIndex={-1}>
        <div className="cc-not-found__card">
          <p className="cc-not-found__eyebrow">404</p>
          <h1 className="cc-not-found__title">There’s nothing at this address.</h1>
          <p className="cc-not-found__body">
            The page you’re looking for doesn’t exist, or you may have followed a broken
            link.
          </p>
          <Link to="/" className="cc-button cc-button--primary">
            Back to ClauseCheck
          </Link>
        </div>
      </main>
    </div>
  );
}
