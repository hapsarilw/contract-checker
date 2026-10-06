import { Link } from "react-router";
import { useAuth } from "../auth/useAuth.js";
import Banner from "./Banner.jsx";
import ResendVerification from "./ResendVerification.jsx";

/**
 * FR-1.7: an UNVERIFIED account may sign in, upload and browse, but
 * analysis returns 403 EMAIL_NOT_VERIFIED. Left to itself the user finds
 * that out by uploading a contract, waiting through the analysing screen,
 * and reading an error. This says so BEFORE they try, names the fix, and
 * offers the fix on the spot.
 *
 * It does NOT disable the upload. The server is the authority on
 * verification and this banner reads a copy of the state that may be
 * stale: an address verified in another tab a minute ago would otherwise
 * leave the button dead until a reload. A stale banner costs a moment of
 * reading; a stale disabled button costs a working feature.
 *
 * `role="group"`, not the "alert" a warning banner gets by default: this
 * is a standing condition of the page, not something that just went
 * wrong, and announcing it as an interruption every time the screen
 * loads would be noise. Not "status" either: ResendVerification carries
 * its own live region, and nesting one inside another announces the
 * result twice.
 *
 * Renders nothing for any other state, including while the session is
 * still loading.
 */
export default function VerifyEmailBanner() {
  const { status, user, refreshUser } = useAuth();
  if (status !== "authenticated" || user.state !== "UNVERIFIED") return null;

  // FR-1.13: unverified because an email CHANGE is waiting on its link
  // (step 75). Pointing this person at "the link we sent when you signed
  // up", and offering to resend it to the OLD address, would send them the
  // wrong way; a new link comes from starting the change again.
  if (user.pendingEmail) {
    return (
      <Banner tone="warning" role="group" title="Confirm your new email to run a check">
        Open the link we sent to <strong>{user.pendingEmail}</strong>. Until you do, your
        address stays <strong>{user.email}</strong> and checks are paused; your reports
        are all still here. Wrong address, or no email?{" "}
        <Link to="/settings">Start the change again in Settings</Link>.
      </Banner>
    );
  }

  return (
    <Banner tone="warning" role="group" title="Verify your email to run a check">
      You can upload and browse now, but a check won&apos;t run until you confirm{" "}
      <strong>{user.email}</strong>. Open the link we sent when you signed up.
      <ResendVerification email={user.email} onAlreadyVerified={refreshUser} />
    </Banner>
  );
}
