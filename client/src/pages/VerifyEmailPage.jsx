import { useEffect, useReducer, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";
import { useAuth } from "../auth/useAuth.js";
import AuthShell from "../components/AuthShell.jsx";
import Button from "../components/Button.jsx";
import ResendVerification from "../components/ResendVerification.jsx";

/**
 * FR-1.7, the /verify-email screen: consumes the token from the emailed
 * link and tells the person what happened.
 *
 * A TOKEN IS SPENT EXACTLY ONCE PER PAGE LOAD, and that takes care under
 * React's StrictMode, which runs every effect, tears it down and runs it
 * again in development. The server's token is single-use, so a naive
 * effect would POST twice, succeed the first time, fail the second with
 * "already used", and show a verified person a failure screen. Both runs
 * therefore await one shared promise per token. The first run's result is
 * ignored (it was cancelled) and the second's is applied, so exactly one
 * request is made and exactly one outcome is shown.
 *
 * WHAT IT CAN AND CANNOT SAY ABOUT A FAILURE. BUILD-PLAN step 63 asks for
 * "expired, already used, invalid" as separate messages. The server does
 * not make that distinction and does so on purpose (services/
 * authTokens.js: one answer for all three, because telling a caller which
 * one it is would be a small oracle for a secret, and the remedy is
 * identical either way: ask for a new link). The client therefore cannot
 * know, and inventing a distinction here would mean guessing. What it
 * does instead is name all three honestly, and add the two things it
 * really does know that the server's answer does not carry:
 *   - the link has no token at all, which a person who has copied half a
 *     URL does see, and
 *   - the visitor is signed in and already verified, in which case a spent
 *     link is not a problem and saying "failed" would be wrong.
 */

/** @type {Map<string, Promise<unknown>>} */
const submissions = new Map();

/** @param {string} token */
function verifyOnce(token) {
  let pending = submissions.get(token);
  if (!pending) {
    pending = apiFetch("/api/v1/auth/verify-email", { method: "POST", body: { token } });
    submissions.set(token, pending);
  }
  return pending;
}

/** @typedef {{ phase: "verifying" } | { phase: "verified" } | { phase: "unusable" } | { phase: "network", message: string } | { phase: "error", message: string }} Outcome */

/**
 * @param {Outcome} _state
 * @param {Outcome} next
 * @returns {Outcome}
 */
const outcome = (_state, next) => next;

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const { status, user, refreshUser } = useAuth();
  const [result, setResult] = useReducer(
    outcome,
    /** @type {Outcome} */ ({ phase: "verifying" }),
  );
  // Bumped by "Try again" to re-run the effect below; the failed attempt
  // was already evicted from `submissions`, so it makes a fresh request.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    setResult({ phase: "verifying" });

    verifyOnce(token).then(
      () => {
        if (cancelled) return;
        setResult({ phase: "verified" });
        // The account's state changed behind the SPA's back; without this
        // the UNVERIFIED banner would outlive the verification.
        void refreshUser();
      },
      (err) => {
        if (cancelled) return;
        // A failed attempt must not be replayed from the cache when the
        // person presses "Try again".
        submissions.delete(token);
        if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
          setResult({ phase: "unusable" });
        } else if (err instanceof ApiError && err.code === "NETWORK_ERROR") {
          setResult({ phase: "network", message: err.message });
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
  const alreadyVerified = signedIn && user.state === "ACTIVE";

  if (!token) {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">This link is incomplete</h1>
        <p className="cc-auth-card__status">
          The verification link is missing its code, which usually means part of it was
          cut off when it was copied. Open the link from your email again, or ask for a
          new one.
        </p>
        <NewLinkActions signedIn={signedIn} email={user?.email} />
      </AuthShell>
    );
  }

  if (result.phase === "verifying") {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">Checking your link</h1>
        <p role="status" className="cc-auth-card__status">
          One moment while we confirm your email address.
        </p>
      </AuthShell>
    );
  }

  if (result.phase === "verified") {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">Email verified</h1>
        <p role="status" className="cc-auth-card__result">
          <strong>You&apos;re all set.</strong>
          Your address is confirmed and you can check contracts now.
        </p>
        <div className="cc-auth-card__actions">
          {signedIn ? (
            <Link className="cc-button cc-button--primary" to="/">
              Check a contract
            </Link>
          ) : (
            <Link className="cc-button cc-button--primary" to="/login">
              Sign in
            </Link>
          )}
        </div>
      </AuthShell>
    );
  }

  if (result.phase === "unusable" && alreadyVerified) {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">You&apos;re already verified</h1>
        <p role="status" className="cc-auth-card__result">
          <strong>Nothing more to do.</strong>
          This link has been used already, and your address is confirmed.
        </p>
        <div className="cc-auth-card__actions">
          <Link className="cc-button cc-button--primary" to="/">
            Check a contract
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (result.phase === "unusable") {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">This link can&apos;t be used</h1>
        <p role="alert" className="cc-auth-card__status">
          It is invalid, it has already been used, or it has expired. A verification link
          works once and lasts 24 hours.
        </p>
        <NewLinkActions
          signedIn={signedIn}
          email={user?.email}
          onAlreadyVerified={refreshUser}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="cc-auth-card__title">
        {result.phase === "network"
          ? "We couldn’t reach the server"
          : "Something went wrong"}
      </h1>
      <p role="alert" className="cc-auth-card__status">
        {result.message} Your link has not been used up, so you can try again.
      </p>
      <div className="cc-auth-card__actions">
        <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
      </div>
    </AuthShell>
  );
}

/**
 * What to do when a link cannot be used: ask for another. That needs a
 * session (the resend endpoint is authenticated, FR-1.7), so a signed-in
 * visitor gets the button and a signed-out one is sent to sign in first.
 * They land on the upload screen, whose own prompt offers the same
 * button, so nobody is left holding a dead link with no next step.
 *
 * @param {{ signedIn: boolean, email?: string, onAlreadyVerified?: () => void }} props
 */
function NewLinkActions({ signedIn, email, onAlreadyVerified }) {
  if (signedIn) {
    return (
      <>
        <ResendVerification email={email} onAlreadyVerified={onAlreadyVerified} />
        <p className="cc-auth-card__aside">
          <Link to="/">Back to ClauseCheck</Link>
        </p>
      </>
    );
  }
  return (
    <>
      <p className="cc-auth-card__status">
        Sign in and we&apos;ll offer to send a new one.
      </p>
      <div className="cc-auth-card__actions">
        <Link className="cc-button cc-button--primary" to="/login?returnTo=%2F">
          Sign in
        </Link>
      </div>
    </>
  );
}
