import { useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";
import { useAuth } from "../auth/useAuth.js";
import { sanitizeReturnTo } from "../auth/returnTo.js";
import Card from "../components/Card.jsx";
import TextField from "../components/TextField.jsx";
import Button from "../components/Button.jsx";
import Banner from "../components/Banner.jsx";
import SkipLink from "../components/SkipLink.jsx";
import "./AuthForm.css";

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;
/** Deliberately permissive — FR-1.1's real shape check is server-side; this only catches an obviously-empty or malformed value early. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COPY = {
  signin: {
    title: "Sign in",
    blurb: "Welcome back. Your previous reports are where you left them.",
    passwordHint: undefined,
    cta: "Sign in",
    switchText: "New here?",
    switchCta: "Create an account",
    switchTo: "/register",
    endpoint: "/api/v1/auth/login",
    failureTitle: "Sign in failed",
  },
  register: {
    title: "Create your account",
    blurb:
      "Email and a password, nothing else. Your account exists so your contract history stays yours.",
    // PRD §6 / step 32 — the password rule stated BEFORE submission, not
    // after rejection. Ported from the prototype's pwHint verbatim.
    passwordHint:
      "At least 10 characters. No symbol requirements — length does the work.",
    cta: "Create account",
    switchText: "Already have an account?",
    switchCta: "Sign in",
    switchTo: "/login",
    endpoint: "/api/v1/auth/register",
    failureTitle: "Couldn't create your account",
  },
};

/**
 * BUILD-PLAN step 32 — the prototype's single "0. AUTH" screen
 * (toggled in place via `authMode`) split into what FR-7.1 actually
 * requires: two routes, /login and /register, sharing this form. The
 * copy, layout and behaviour it toggled between are preserved in COPY
 * above; switching modes here is a real navigation (`<Link>`) between
 * the two routes, not a local state flip.
 *
 * @param {{ mode: "signin" | "register" }} props
 */
export default function AuthForm({ mode }) {
  const copy = COPY[mode];
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const auth = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState(
    /** @type {{ email?: string, password?: string }} */ ({}),
  );
  const [submitError, setSubmitError] = useState(
    /** @type {{ title: string, message: string, code: string, status: number } | null} */ (
      null
    ),
  );
  const [submitting, setSubmitting] = useState(false);

  const sessionExpired = searchParams.get("reason") === "session_expired";

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    /** @type {{ email?: string, password?: string }} */
    const nextFieldErrors = {};
    if (!EMAIL_PATTERN.test(email)) {
      nextFieldErrors.email = "Enter a valid email address, like you@studio.com.";
    }
    if (mode === "register" && password.length < MIN_PASSWORD_LENGTH) {
      nextFieldErrors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (mode === "register" && password.length > MAX_PASSWORD_LENGTH) {
      nextFieldErrors.password = `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
    } else if (password.length === 0) {
      nextFieldErrors.password = "Enter your password.";
    }

    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) return;

    setSubmitError(null);
    setSubmitting(true);
    try {
      const body = /** @type {{ user: import("../auth/AuthContext.js").AuthUser }} */ (
        await apiFetch(copy.endpoint, { method: "POST", body: { email, password } })
      );
      auth.setUser(body.user);
      navigate(sanitizeReturnTo(searchParams.get("returnTo")), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError({
          title: copy.failureTitle,
          message: err.message,
          code: err.code,
          status: err.status,
        });
      } else {
        throw err;
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="cc-auth-page">
      <SkipLink />
      <div className="cc-auth-page__frame">
        <div className="cc-auth-page__brand">
          <span className="cc-auth-page__brand-mark" aria-hidden="true" />
          <span className="cc-auth-page__brand-name">ClauseCheck</span>
        </div>

        {/* tabIndex={-1}: a <main> is not focusable by default, so
            activating the skip link above would scroll here without ever
            moving actual keyboard focus — programmatically focusable
            (never in the Tab order otherwise) is what makes the skip
            link's target real. */}
        <main id="main" tabIndex={-1}>
          <Card accent className="cc-auth-card">
            <h1 className="cc-auth-card__title">{copy.title}</h1>
            <p className="cc-auth-card__blurb">{copy.blurb}</p>

            {sessionExpired ? (
              <Banner
                tone="warning"
                className="cc-auth-card__error"
                title="You were signed out"
              >
                Your session expired. Sign in again to pick up where you left off.
              </Banner>
            ) : null}

            {submitError ? (
              <Banner
                tone="danger"
                className="cc-auth-card__error"
                title={submitError.title}
              >
                {submitError.message}
                <div className="cc-auth-card__error-code">
                  {submitError.code} · {submitError.status}
                </div>
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
                  error={fieldErrors.email}
                />
              </div>
              <div className="cc-auth-card__field">
                <TextField
                  label="Password"
                  type="password"
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  placeholder="••••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  hint={copy.passwordHint}
                  error={fieldErrors.password}
                />
              </div>
              <Button type="submit" fullWidth disabled={submitting}>
                {submitting ? "Working…" : copy.cta}
              </Button>
            </form>

            <div className="cc-auth-card__switch">
              {copy.switchText}{" "}
              <Link className="cc-auth-card__switch-link" to={copy.switchTo}>
                {copy.switchCta}
              </Link>
            </div>
          </Card>
        </main>
        <p className="cc-auth-page__footnote">
          Your contracts are private to your account, and you can delete any of them
          permanently once you're done.
        </p>
      </div>
    </div>
  );
}
