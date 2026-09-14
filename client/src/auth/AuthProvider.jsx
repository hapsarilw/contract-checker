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

  const signOut = useCallback(() => {
    setState({ status: "unauthenticated", user: null });
  }, []);

  const value = useMemo(
    () => ({ ...state, setUser, signOut }),
    [state, setUser, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
