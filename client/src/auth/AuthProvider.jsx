import { useCallback, useEffect, useMemo, useState } from "react";
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
 * @param {{ children: import("react").ReactNode }} props
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState(
    /** @type {import("./AuthContext.js").AuthState} */ ({
      status: "loading",
      user: null,
    }),
  );

  useEffect(() => {
    let cancelled = false;

    // suppressAuthRedirect: a 401 here means "nobody's signed in yet,"
    // not "your session was revoked" — see client.js's own note on this
    // flag for the bug this avoids (a spurious "session expired" banner
    // on /login's own first load).
    apiFetch("/api/v1/auth/me", { suppressAuthRedirect: true }).then(
      (body) => {
        if (cancelled) return;
        const user = /** @type {{ user: import("./AuthContext.js").AuthUser }} */ (body)
          .user;
        setState({ status: "authenticated", user });
      },
      () => {
        if (cancelled) return;
        // A 401 here is the ordinary "nobody's signed in yet" case, not
        // a failure. Any other rejection (a network failure, a 500)
        // still leaves the app in "not signed in" rather than stuck on
        // "loading" forever — this initial check has no UI of its own
        // to report a transport error through.
        setState({ status: "unauthenticated", user: null });
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

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
    () => ({ ...state, setUser, signOut, clearSession, refreshUser }),
    [state, setUser, signOut, clearSession, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
