import { useEffect, useReducer, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";
import { useAuth } from "../auth/useAuth.js";
import AuthShell from "../components/AuthShell.jsx";
import Button from "../components/Button.jsx";

/**
 * FR-1.13's second half, the /confirm-email-change screen (BUILD-PLAN step
 * 75): consumes the token from the link sent to the NEW address. The
 * address changes here and nowhere else.
 *
 * Built like /verify-email (VerifyEmailPage.jsx says why at length): the
 * token is spent exactly once per page load, StrictMode's double effect
 * included, by sharing one promise per token; and the server's single
 * answer for invalid, used and expired links is named honestly rather
 * than split into a guess.
 *
 * Public, like /verify-email: the link is opened from a mailbox, often in
 * a browser that is not signed in. Signed in or not, the change is the
 * same; only the next step differs.
 */

/** @type {Map<string, Promise<unknown>>} */
const submissions = new Map();

/** @param {string} token */
function confirmOnce(token) {
  let pending = submissions.get(token);
  if (!pending) {
    pending = apiFetch("/api/v1/auth/confirm-email-change", {
      method: "POST",
      body: { token },
    });
    submissions.set(token, pending);
  }
  return pending;
}

/** @typedef {{ phase: "confirming" } | { phase: "changed", email: string } | { phase: "unusable" } | { phase: "error", message: string }} Outcome */

/**
 * @param {Outcome} _state
 * @param {Outcome} next
 * @returns {Outcome}
 */
const outcome = (_state, next) => next;

export default function ConfirmEmailChangePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const { status, refreshUser } = useAuth();
  const [result, setResult] = useReducer(
    outcome,
    /** @type {Outcome} */ ({ phase: "confirming" }),
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    setResult({ phase: "confirming" });

    confirmOnce(token).then(
      (body) => {
        if (cancelled) return;
        const email = /** @type {{ email?: string }} */ (body)?.email ?? "";
        setResult({ phase: "changed", email });
        // The session's copy of the account still holds the old address
        // and the paused state; without this they would outlive the change.
        void refreshUser();
      },
      (err) => {
        if (cancelled) return;
        submissions.delete(token);
        if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
          setResult({ phase: "unusable" });
        } else {
          setResult({
            phase: "error",
            message: err instanceof ApiError ? err.message : "Something went wrong.",
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [token, refreshUser, attempt]);

  const signedIn = status === "authenticated";
  const nextStep = signedIn ? (
    <Link className="cc-button cc-button--primary" to="/settings">
      Back to settings
    </Link>
  ) : (
    <Link className="cc-button cc-button--primary" to="/login">
      Sign in
    </Link>
  );

  if (!token) {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">This link is incomplete</h1>
        <p className="cc-auth-card__status">
          The confirmation link is missing its code, which usually means part of it was
          cut off when it was copied. Open the link from your email again, or start the
          change again from Settings.
        </p>
        <div className="cc-auth-card__actions">{nextStep}</div>
      </AuthShell>
    );
  }

  if (result.phase === "confirming") {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">Checking your link</h1>
        <p role="status" className="cc-auth-card__status">
          One moment while we confirm your new email address.
        </p>
      </AuthShell>
    );
  }

  if (result.phase === "changed") {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">Email changed</h1>
        <p role="status" className="cc-auth-card__result">
          <strong>Your address is now {result.email}.</strong>
          Sign in with it from now on. Checks are running again.
        </p>
        <div className="cc-auth-card__actions">{nextStep}</div>
      </AuthShell>
    );
  }

  if (result.phase === "unusable") {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">This link can&apos;t be used</h1>
        <p role="alert" className="cc-auth-card__status">
          It is invalid, it has already been used, it has expired, or a newer change
          replaced it. Your address has not changed. Start the change again from Settings
          to get a new link.
        </p>
        <div className="cc-auth-card__actions">{nextStep}</div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="cc-auth-card__title">We couldn&apos;t confirm it</h1>
      <p role="alert" className="cc-auth-card__status">
        {result.message} Your link has not been used up, so you can try again.
      </p>
      <div className="cc-auth-card__actions">
        <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
      </div>
    </AuthShell>
  );
}
