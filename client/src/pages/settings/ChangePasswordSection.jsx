import { useState } from "react";
import { apiFetch, ApiError } from "../../api/client.js";
import Banner from "../../components/Banner.jsx";
import Button from "../../components/Button.jsx";
import TextField from "../../components/TextField.jsx";
import SettingsSection from "./SettingsSection.jsx";

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;
const PASSWORD_HINT =
  "At least 10 characters. No symbol requirements; length does the work.";

/**
 * FR-1.11. Asks for the CURRENT password as well as the new one: someone
 * at an unlocked laptop should not be able to change the password with a
 * session cookie alone.
 *
 * WHAT THE SERVER DOES, told honestly. It signs every OTHER session out
 * and issues this one a fresh cookie, so the person stays signed in here.
 * The success message says exactly that, because "password changed" alone
 * leaves someone wondering whether their phone is still signed in.
 *
 * WHICH FIELD AN ERROR BELONGS TO. A wrong current password and a
 * breached new one are both 400 VALIDATION_ERROR and the client sees only
 * the message (SRS §4: `details` stay server-side). The message is the
 * server's and names the fix, so it is shown as it arrives, next to the
 * field it is about. That is decided by the message, which is a heuristic
 * and is the honest limit of an API that does not name the field.
 */
export default function ChangePasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [errors, setErrors] = useState(
    /** @type {{ current?: string, next?: string }} */ ({}),
  );
  const [banner, setBanner] = useState(/** @type {string | null} */ (null));
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function handleSubmit(event) {
    event.preventDefault();
    if (saving) return;
    setChanged(false);

    /** @type {{ current?: string, next?: string }} */
    const found = {};
    if (current === "") found.current = "Enter your current password.";
    if (next.length < MIN_PASSWORD_LENGTH) {
      found.next = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (next.length > MAX_PASSWORD_LENGTH) {
      found.next = `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
    }
    setErrors(found);
    setBanner(null);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    try {
      await apiFetch("/api/v1/auth/change-password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      });
      setCurrent("");
      setNext("");
      setChanged(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
        if (/current password/i.test(err.message)) setErrors({ current: err.message });
        else setErrors({ next: err.message });
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
    <SettingsSection title="Change your password">
      <p className="cc-settings__lede">
        Changing it signs out every other device. This one stays signed in.
      </p>

      {banner ? (
        <Banner
          tone="danger"
          className="cc-settings__banner"
          title="We couldn’t change it"
        >
          {banner}
        </Banner>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="cc-settings__form">
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          error={errors.current}
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          hint={PASSWORD_HINT}
          error={errors.next}
        />
        <div className="cc-settings__actions">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Change password"}
          </Button>
          <p role="status" aria-live="polite" className="cc-settings__status">
            {changed ? "Password changed. Your other devices were signed out." : ""}
          </p>
        </div>
      </form>
    </SettingsSection>
  );
}
