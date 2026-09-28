import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";
import AuthShell from "../components/AuthShell.jsx";
import Banner from "../components/Banner.jsx";
import Button from "../components/Button.jsx";
import TextField from "../components/TextField.jsx";

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

/**
 * The rule, stated BEFORE the person types (PRD §6 / FR-1.2): rejecting a
 * password and only then explaining why is the wrong order. Worded the
 * same as the registration form's hint so the two screens do not describe
 * one rule two ways.
 */
const PASSWORD_HINT =
  "At least 10 characters. No symbol requirements; length does the work.";

/**
 * FR-1.8 / FR-1.9, the /reset-password screen.
 *
 * WHAT THE SERVER DOES ON SUCCESS, which this screen has to tell the
 * truth about. It sets the new password, increments tokenVersion (so
 * EVERY session on every device is signed out) and does NOT sign this
 * browser in: holding a mailbox link proves the mailbox, not that this
 * browser is that person. So the success message says both things a
 * person needs to hear, that their other sessions are gone and that they
 * sign in with the new password, and it does not pretend they are already
 * signed in.
 *
 * ONE 400 FOR TWO DIFFERENT PROBLEMS. A bad link and a breached password
 * both come back as VALIDATION_ERROR, and the client sees only the code
 * and message (the machine-readable `details` never leave the server, per
 * SRS §4's error shape). The message is the server's and already names
 * the fix, so it is shown as it arrives, and the "request a new link"
 * route is offered alongside it either way: it is the right next step for
 * a dead link and harmless for a weak password.
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const [submitError, setSubmitError] = useState(/** @type {string | null} */ (null));
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      setFieldError(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
      return;
    }
    setFieldError(undefined);
    setSubmitError(null);
    setSubmitting(true);
    try {
      await apiFetch("/api/v1/auth/reset-password", {
        method: "POST",
        body: { token, password },
      });
      setPassword("");
      setDone(true);
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

  if (!token) {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">This link is incomplete</h1>
        <p className="cc-auth-card__status">
          The reset link is missing its code, which usually means part of it was cut off
          when it was copied. Open the link from your email again, or request a new one.
        </p>
        <div className="cc-auth-card__actions">
          <Link className="cc-button cc-button--primary" to="/forgot-password">
            Request a new link
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <h1 className="cc-auth-card__title">Password changed</h1>
        <p role="status" className="cc-auth-card__result">
          <strong>Sign in with your new password.</strong>
          Every other device that was signed in has been signed out.
        </p>
        <div className="cc-auth-card__actions">
          <Link className="cc-button cc-button--primary" to="/login">
            Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="cc-auth-card__title">Choose a new password</h1>
      <p className="cc-auth-card__blurb">
        Pick something you haven&apos;t used anywhere else. When you save it, every device
        that was signed in is signed out.
      </p>

      {submitError ? (
        <Banner tone="danger" className="cc-auth-card__error" title="That didn’t work">
          {submitError}
        </Banner>
      ) : null}

      <form onSubmit={handleSubmit} noValidate>
        <div className="cc-auth-card__field">
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={PASSWORD_HINT}
            error={fieldError}
          />
        </div>
        <Button type="submit" fullWidth disabled={submitting}>
          {submitting ? "Saving…" : "Save new password"}
        </Button>
      </form>

      <div className="cc-auth-card__switch">
        Link not working?{" "}
        <Link className="cc-auth-card__switch-link" to="/forgot-password">
          Request a new one
        </Link>
      </div>
    </AuthShell>
  );
}
