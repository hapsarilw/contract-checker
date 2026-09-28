import { useState } from "react";
import { apiFetch, ApiError } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import Banner from "../../components/Banner.jsx";
import Button from "../../components/Button.jsx";
import SettingsSection from "./SettingsSection.jsx";

/**
 * FR-1.9's user-facing answer to a lost laptop: increments tokenVersion,
 * so every session dies, this one included. No password is asked for: it
 * can only REDUCE access, and demanding a password of someone who fears
 * their account is compromised would leave them hunting for it.
 *
 * The server clears this browser's cookie as part of the request, so the
 * session is forgotten locally WITHOUT a second request. Calling the
 * ordinary sign-out here would POST /logout with a cookie that no longer
 * works, get a 401, and land the user on the "your session expired"
 * message for a sign-out they asked for.
 */
export default function SignOutEverywhereSection() {
  const { clearSession } = useAuth();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  async function handleClick() {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await apiFetch("/api/v1/auth/logout-all", { method: "POST" });
      // RequireAuth performs the redirect to /login?reason=signed_out_everywhere.
      clearSession("signed_out_everywhere");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong. Try again in a moment.",
      );
      setWorking(false);
    }
  }

  return (
    <SettingsSection title="Sign out everywhere">
      <p className="cc-settings__lede">
        Ends every session on every device, including this one. Use it if you lost a
        laptop or think someone else has your session.
      </p>
      {error ? (
        <Banner
          tone="danger"
          className="cc-settings__banner"
          title="We couldn’t sign you out"
        >
          {error}
        </Banner>
      ) : null}
      <div className="cc-settings__actions">
        <Button variant="secondary" onClick={handleClick} disabled={working}>
          {working ? "Signing out…" : "Sign out everywhere"}
        </Button>
      </div>
    </SettingsSection>
  );
}
