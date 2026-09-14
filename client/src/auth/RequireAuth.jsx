import { Navigate, useLocation } from "react-router";
import { useAuth } from "./useAuth.js";

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
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <p role="status" aria-live="polite">
        {"Loading…"}
      </p>
    );
  }

  if (status === "unauthenticated") {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

  return children;
}
