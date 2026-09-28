import { useState } from "react";
import { Link } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";
import AuthShell from "../components/AuthShell.jsx";
import Banner from "../components/Banner.jsx";
import Button from "../components/Button.jsx";
import TextField from "../components/TextField.jsx";

/** Deliberately permissive, like AuthForm's: the server's shape check is the real one. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * FR-1.8, the /forgot-password screen.
 *
 * THE CONFIRMATION IS IDENTICAL WHETHER OR NOT THE ADDRESS HAS AN ACCOUNT,
 * and that is a property of this file, not only of the server. The API
 * answers 202 with the same body either way, so there is nothing here that
 * COULD branch on it; but the UI has its own ways to leak, and each one is
 * closed on purpose:
 *
 *   - One confirmation, one wording, no "we sent it to X" that would echo
 *     an address back as though it were known.
 *   - No timing tell: the confirmation appears when the request settles,
 *     and the server itself takes the same path for both.
 *   - The rate-limit message (429) is safe to show as it arrives: the
 *     limiter is keyed on the SUBMITTED string, so it fires identically for
 *     an address that exists and one that does not, and says nothing about
 *     which.
 *
 * "If that address has an account" is the honest phrasing of a deliberate
 * non-answer. It reads as slightly evasive, and the alternative is an
 * account-enumeration endpoint.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const [submitError, setSubmitError] = useState(/** @type {string | null} */ (null));
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const trimmed = email.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setFieldError("Enter a valid email address, like you@studio.com.");
      return;
    }
    setFieldError(undefined);
    setSubmitError(null);
    setSubmitting(true);
    try {
      await apiFetch("/api/v1/auth/forgot-password", {
        method: "POST",
        body: { email: trimmed },
      });
      setSent(true);
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong. Try again in a moment.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">Check your inbox</h1>
        <p role="status" className="cc-auth-card__result">
          <strong>A reset link is on its way.</strong>
          If that address has an account, we&apos;ve sent a link to choose a new password.
          It works once and lasts 30 minutes.
        </p>
        <p className="cc-auth-card__status">
          Nothing there after a few minutes? Check your spam folder, or try again with the
          address you signed up with.
        </p>
        <div className="cc-auth-card__actions">
          <Link className="cc-button cc-button--primary" to="/login">
            Back to sign in
          </Link>
          <Button
            variant="secondary"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
          >
            Use a different address
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="cc-auth-card__title">Forgot your password?</h1>
      <p className="cc-auth-card__blurb">
        Enter your email and we&apos;ll send a link to choose a new one. It works for 30
        minutes.
      </p>

      {submitError ? (
        <Banner
          tone="danger"
          className="cc-auth-card__error"
          title="We couldn’t send that"
        >
          {submitError}
        </Banner>
      ) : null}

      <form onSubmit={handleSubmit} noValidate>
        <div className="cc-auth-card__field">
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@studio.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldError}
          />
        </div>
        <Button type="submit" fullWidth disabled={submitting}>
          {submitting ? "Sending…" : "Send reset link"}
        </Button>
      </form>

      <div className="cc-auth-card__switch">
        Remembered it?{" "}
        <Link className="cc-auth-card__switch-link" to="/login">
          Back to sign in
        </Link>
      </div>
    </AuthShell>
  );
}
