import Banner from "../components/Banner.jsx";
import Button from "../components/Button.jsx";
import SkipLink from "../components/SkipLink.jsx";
import { useAuth } from "../auth/useAuth.js";
import "./NotFoundPage.css";

/**
 * BUILD-PLAN step 75 — what a protected route shows when the session
 * check could not be answered (AuthProvider.jsx's "unavailable" state):
 * a database outage, a network failure, a 5xx. Before this, the same
 * moment redirected to /login, which told a signed-in person they were
 * signed out and offered them a form that would fail.
 *
 * It says what is known and no more: the server could not be reached;
 * whether this person is signed in is unknown, so it says that a sign-in
 * they had is still there rather than asking for one. The server's own
 * message comes first, because during a database outage it is the one
 * that says nothing was lost.
 *
 * The message is `role="alert"`: it replaces "Loading…", and a screen
 * reader user should hear why the page they asked for did not come.
 * Focus is not moved by script, as on every other screen, so the first
 * Tab still reaches the skip link. The retry button stays in place while
 * a retry runs (aria-disabled, relabelled) rather than unmounting under the
 * keyboard.
 *
 * Laid out as the 404 page is (its card, its type): the same moment of
 * "this is not the page you came for", in the same visual language.
 */
export default function SessionUnavailablePage() {
  const auth = useAuth();
  if (auth.status !== "unavailable") return null;
  const seconds = auth.retryAfter;

  return (
    <div className="cc-not-found">
      <SkipLink />
      <main id="main" tabIndex={-1}>
        <div className="cc-not-found__card">
          <h1 className="cc-not-found__title">ClauseCheck can’t be reached right now.</h1>
          <Banner tone="warning">{auth.message}</Banner>
          <p className="cc-not-found__body">
            If you were signed in, you still are: nothing here signed you out. This page
            tries again by itself every {seconds} seconds, and opens as soon as the
            service answers.
          </p>
          {/* aria-disabled, not disabled: a focused button that becomes
              disabled loses focus to <body> (HTML's focus fixup), which is
              the drop this screen promises not to make. */}
          <Button
            aria-disabled={auth.checking}
            onClick={() => {
              if (!auth.checking) auth.retrySessionCheck();
            }}
          >
            {auth.checking ? "Trying again…" : "Try again now"}
          </Button>
        </div>
      </main>
    </div>
  );
}
