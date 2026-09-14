/**
 * BUILD-PLAN step 32, SRS §7.15 — "a skip link to main." The first
 * focusable element on every page; invisible until it has focus
 * (.cc-skip-link in global.css), so a sighted mouse user never sees it
 * and a keyboard user's very first Tab lands on it.
 *
 * `targetId` defaults to "main" to match `<main id="main">`, the
 * landmark every screen wraps its content in.
 *
 * @param {{ targetId?: string }} props
 */
export default function SkipLink({ targetId = "main" }) {
  return (
    <a className="cc-skip-link" href={`#${targetId}`}>
      Skip to main content
    </a>
  );
}
