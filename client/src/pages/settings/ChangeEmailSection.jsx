import { useState } from "react";
import { apiFetch, ApiError } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import Banner from "../../components/Banner.jsx";
import Button from "../../components/Button.jsx";
import TextField from "../../components/TextField.jsx";
import SettingsSection from "./SettingsSection.jsx";

/**
 * FR-1.13, the screen for it (BUILD-PLAN step 75). The API has existed
 * since the account work of Phase 1.5; with no screen, the privacy policy
 * had to tell people to write in to correct their address.
 *
 * WHAT HAPPENS, told before it happens. FR-1.13 puts the account back
 * into UNVERIFIED as soon as a change is requested, and the address
 * changes only when the link sent to the NEW one is opened. So until then
 * new checks are paused (EMAIL_NOT_VERIFIED), the old address still signs
 * in, and reports stay readable. The lede says all of that; "nothing
 * changes until you confirm", which is what it is tempting to write, would
 * be untrue on the very next analysis.
 *
 * The current password is asked for for the same reason as on the
 * password form: a session cookie alone, on an unlocked laptop, must not
 * be enough to move the account somewhere else.
 *
 * After a request, the session's copy of the account is refreshed, so the
 * banner that explains the paused checks appears at once
 * (VerifyEmailBanner's pending-change variant).
 */
export default function ChangeEmailSection() {
  const { refreshUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState(
    /** @type {{ email?: string, password?: string }} */ ({}),
  );
  const [banner, setBanner] = useState(/** @type {string | null} */ (null));
  const [saving, setSaving] = useState(false);
  const [sentTo, setSentTo] = useState(/** @type {string | null} */ (null));

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function handleSubmit(event) {
    event.preventDefault();
    if (saving) return;
    setSentTo(null);

    const address = email.trim();
    /** @type {{ email?: string, password?: string }} */
    const found = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      found.email = "Enter the new email address, like name@example.com.";
    }
    if (password === "") found.password = "Enter your current password.";
    setErrors(found);
    setBanner(null);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    try {
      await apiFetch("/api/v1/auth/change-email", {
        method: "POST",
        body: { email: address, currentPassword: password },
      });
      setEmail("");
      setPassword("");
      setSentTo(address);
      void refreshUser();
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_TAKEN") {
        setErrors({ email: err.message });
      } else if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
        // As on the password form, the message decides the field: the
        // API does not name it (SRS §4: details stay server-side).
        if (/password/i.test(err.message)) setErrors({ password: err.message });
        else setErrors({ email: err.message });
      } else {
        setBanner(
          err instanceof ApiError
            ? err.message
            : "Something went wrong. Try again in a moment.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Change your email">
      <p className="cc-settings__lede">
        We send a link to the new address, and your address changes when you open it.
        Until then you sign in with your current address, your reports stay readable, and
        new checks are paused. We also tell your current address about the change.
      </p>

      {banner ? (
        <Banner
          tone="danger"
          className="cc-settings__banner"
          title="We couldn’t start the change"
        >
          {banner}
        </Banner>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="cc-settings__form">
        <TextField
          label="New email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email}
        />
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errors.password}
        />
        <div className="cc-settings__actions">
          <Button type="submit" disabled={saving}>
            {saving ? "Sending…" : "Send confirmation link"}
          </Button>
          <p role="status" aria-live="polite" className="cc-settings__status">
            {sentTo
              ? `Check ${sentTo} for the confirmation link. Your address changes when you open it.`
              : ""}
          </p>
        </div>
      </form>
    </SettingsSection>
  );
}
