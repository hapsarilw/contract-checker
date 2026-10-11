import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../api/client.js";
import { AuthContext } from "./AuthContext.js";

/**
 * BUILD-PLAN step 32 / FR-7.7 — "Auth state lives in the httpOnly
 * cookie; the SPA checks /api/v1/auth/me on load." This is that check,
 * and the in-memory (never localStorage/sessionStorage — FR-7.7) session
 * state every route guard and screen reads from `useAuth()`.
 *
 * Also where step 31's `clausecheck:session-expired` CustomEvent
 * (api/client.js, dispatched on a 401 UNAUTHENTICATED/SESSION_REVOKED)
 * gets a listener: this is the "future in-memory auth/user store" that
 * comment named. api/client.js still doesn't import this file — the
 * event is what keeps that a one-way dependency.
 *
 * A CHECK THAT COULD NOT BE ANSWERED [step 75] is not "signed out". Only
 * a 401 says nobody is signed in. Anything else (the database down, a
 * network failure, a 5xx) means the server could not say, and until step
 * 75 it was treated as signed out: during a database outage a signed-in
 * person reloading the app landed on the sign-in page, where signing in
 * then failed with the stated 503. Now it is the "unavailable" state,
 * carrying the server's own message; RequireAuth shows it instead of
 * redirecting, and the check runs again by itself after the server's
 * Retry-After (or DEFAULT_RECHECK_SECONDS), or when the person asks.
 *
 * @param {{ children: import("react").ReactNode }} props
 */
/** When the server named no wait: the same half minute errorCodes.js gives DATABASE_UNAVAILABLE. */
/** @param {import("./AuthContext.js").AuthState} s */
const waiting = (s) => s.status === "loading" || s.status === "unavailable";

export const DEFAULT_RECHECK_SECONDS = 30;
/** So a long Retry-After (a rate limit's 15 minutes) does not leave the screen waiting that long. */
export const MAX_RECHECK_SECONDS = 120;

const UNKNOWN_FAILURE_MESSAGE =
  "We couldn't reach ClauseCheck just now. Try again in a minute.";

/**
 * The "unavailable" state for a check that failed with anything but a 401.
 * The message is the server's (SRS §4 messages are written for the
 * person reading them), or api/client.js's own for a network failure.
 *
 * @param {unknown} err
 * @returns {import("./AuthContext.js").AuthState}
 */
function unavailableState(err) {
  const e = /** @type {{ message?: unknown, retryAfter?: unknown }} */ (err ?? {});
  const message =
    typeof e.message === "string" && e.message.length > 0 && "status" in e
      ? e.message
      : UNKNOWN_FAILURE_MESSAGE;
  const asked =
    typeof e.retryAfter === "number" && e.retryAfter > 0
      ? e.retryAfter
      : DEFAULT_RECHECK_SECONDS;
  return {
    status: "unavailable",
    user: null,
    message,
    retryAfter: Math.min(asked, MAX_RECHECK_SECONDS),
    checking: false,
  };
}

/** @param {unknown} err */
const isUnauthenticated = (err) =>
  typeof err === "object" && err !== null && "status" in err && err.status === 401;

export function AuthProvider({ children }) {
  const [state, setState] = useState(
    /** @type {import("./AuthContext.js").AuthState} */ ({
      status: "loading",
      user: null,
    }),
  );

  // False once unmounted, so a check that resolves afterwards sets nothing.
  const mounted = useRef(true);

  /**
   * One GET /auth/me. Its answer applies only while the app is still
   * waiting on one (loading, or unavailable): a sign-in that succeeded on
   * /login while a re-check was in flight must not be overwritten by
   * that re-check's 503.
   */
  const checkSession = useCallback(() => {
    // suppressAuthRedirect: a 401 here means "nobody's signed in yet,"
    // not "your session was revoked" — see client.js's own note on this
    // flag for the bug this avoids (a spurious "session expired" banner
    // on /login's own first load).
    return apiFetch("/api/v1/auth/me", { suppressAuthRedirect: true }).then(
      (body) => {
        if (!mounted.current) return;
        const user = /** @type {{ user: import("./AuthContext.js").AuthUser }} */ (body)
          .user;
        setState((s) => (waiting(s) ? { status: "authenticated", user } : s));
      },
      (err) => {
        if (!mounted.current) return;
        // A 401 is the ordinary "nobody's signed in yet" case. Anything
        // else is a check the server could not answer (see the header).
        const next = isUnauthenticated(err)
          ? /** @type {const} */ ({ status: "unauthenticated", user: null })
          : unavailableState(err);
        setState((s) => (waiting(s) ? next : s));
      },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    checkSession();
    return () => {
      mounted.current = false;
    };
  }, [checkSession]);

  const retrySessionCheck = useCallback(() => {
    setState((s) => (s.status === "unavailable" ? { ...s, checking: true } : s));
    return checkSession();
  }, [checkSession]);

  // Unavailable: check again by itself after the server's own wait, so the
  // screen clears when the outage does, with nobody pressing anything.
  const recheckInSeconds =
    state.status === "unavailable" && !state.checking ? state.retryAfter : null;
  useEffect(() => {
    if (recheckInSeconds === null) return undefined;
    const timer = setTimeout(retrySessionCheck, recheckInSeconds * 1000);
    return () => clearTimeout(timer);
  }, [recheckInSeconds, retrySessionCheck]);

  useEffect(() => {
    function onSessionExpired() {
      setState({ status: "unauthenticated", user: null });
    }
    window.addEventListener("clausecheck:session-expired", onSessionExpired);
    return () =>
      window.removeEventListener("clausecheck:session-expired", onSessionExpired);
  }, []);

  /** @param {import("./AuthContext.js").AuthUser} user */
  const setUser = useCallback((user) => {
    setState({ status: "authenticated", user });
  }, []);

  /**
   * BUILD-PLAN step 39 — the "Sign out" nav control's handler. Step 32
   * left this clearing only local state, with no chrome yet to call it;
   * that was never actually "signed out" from the server's point of
   * view — the httpOnly session cookie (FR-7.7) was still valid, so the
   * next `/auth/me` (a reload, another tab) would silently re-
   * authenticate the same session. POST /api/v1/auth/logout
   * (server/src/routes/auth.js) is what actually clears it.
   *
   * Local state clears in `finally`, even if the request fails (offline,
   * a 5xx): the user asked to leave, and the UI honouring that is more
   * important than the request succeeding — the cookie a failed call
   * left behind is bounded by ordinary session expiry either way, the
   * same as it would be if the tab were simply closed.
   */
  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // See the comment above: state clears regardless.
    } finally {
      setState({ status: "unauthenticated", user: null });
    }
  }, []);

  /**
   * Forgets the session locally, with NO request. For the two moments the
   * server has already ended it: sign-out-everywhere (which clears the
   * cookie itself) and account deletion (where the user row is gone).
   * Calling `signOut()` there would POST /logout with a cookie that no
   * longer works, get a 401, and bounce the user through the
   * "your session expired" redirect, which is the wrong message for a
   * sign-out the user just asked for.
   *
   * `reason` is why, and RequireAuth turns it into the redirect to
   * /login?reason=... itself. The caller must NOT navigate on its own:
   * clearing the session makes RequireAuth redirect within the same
   * render, and that redirect (which would carry a returnTo to a page the
   * person no longer has access to) wins any race against a navigate() of
   * the caller's, so the reason would be lost.
   *
   * @param {string} [reason]
   */
  const clearSession = useCallback((reason) => {
    setState({ status: "unauthenticated", user: null, endedBecause: reason });
  }, []);

  /**
   * Re-reads GET /auth/me. Used once the account's state has changed on
   * the server behind the SPA's back, i.e. an email was just verified, so
   * the UNVERIFIED banner clears without a page reload. A failure is
   * swallowed on purpose: the caller has already done the thing it cared
   * about, and a stale banner is a smaller problem than an error dialog
   * about a refresh nobody asked for.
   */
  const refreshUser = useCallback(async () => {
    try {
      const body = /** @type {{ user: import("./AuthContext.js").AuthUser }} */ (
        await apiFetch("/api/v1/auth/me", { suppressAuthRedirect: true })
      );
      setState({ status: "authenticated", user: body.user });
    } catch {
      // See above.
    }
  }, []);

  const value = useMemo(
    () => ({ ...state, setUser, signOut, clearSession, refreshUser, retrySessionCheck }),
    [state, setUser, signOut, clearSession, refreshUser, retrySessionCheck],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
