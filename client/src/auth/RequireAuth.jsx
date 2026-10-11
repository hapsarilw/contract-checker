import { Navigate, useLocation } from "react-router";
import { useAuth } from "./useAuth.js";
import SessionUnavailablePage from "../pages/SessionUnavailablePage.jsx";

/**
 * BUILD-PLAN step 32, FR-7.1 — "All but auth routes redirect
 * unauthenticated users to /login." Wraps a route's element; step 39
 * applies this same component to every remaining protected route once
 * they exist.
 *
 * No `reason` query parameter on this redirect, deliberately, unlike
 * api/client.js's 401 interceptor: THAT redirect fires when a session
 * that was valid stops being valid mid-use (FR-7.12 — "an explanatory
 * message" earns its keep there, because something genuinely happened).
 * This one fires just as often for a visitor who was never signed in at
 * all and followed a link straight to a protected route — telling them
 * their "session expired" would be a plain untruth. `returnTo` still
 * carries the destination either way, so signing in still lands them
 * back here.
 *
 * @param {{ children: import("react").ReactNode }} props
 */
export function RequireAuth({ children }) {
  const auth = useAuth();
  const { status } = auth;
  const location = useLocation();

  if (status === "loading") {
    return (
      <p role="status" aria-live="polite">
        {"Loading…"}
      </p>
    );
  }

  // Step 75: the check could not be answered (the database down, the
  // network). Whether anyone is signed in is unknown, so this neither
  // shows the page nor sends a possibly signed-in person to /login.
  if (status === "unavailable") {
    return <SessionUnavailablePage />;
  }

  if (status === "unauthenticated") {
    // A session the app itself ended on purpose (sign-out-everywhere,
    // account deletion) goes to /login saying so, with no returnTo: there
    // is nothing to return to.
    if (auth.endedBecause) {
      return (
        <Navigate to={`/login?reason=${encodeURIComponent(auth.endedBecause)}`} replace />
      );
    }
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

  return children;
}
