import { useState } from "react";
import { apiFetch, ApiError } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import Button from "../../components/Button.jsx";
import DeleteAccountDialog from "../../components/DeleteAccountDialog.jsx";
import SettingsSection from "./SettingsSection.jsx";

/**
 * FR-4.6. The trigger is a plain outlined button and the weight is in the
 * dialog it opens: one step removed from doing anything irreversible.
 *
 * ON SUCCESS the user row no longer exists, so every cookie fails by
 * absence and the session is forgotten locally with NO further request
 * (see SignOutEverywhereSection for why the ordinary sign-out is wrong
 * here). They land on /login, where a notice says the deletion happened
 * and that a confirmation is on its way.
 */
export default function DeleteAccountSection() {
  const { clearSession } = useAuth();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [errorIsPassword, setErrorIsPassword] = useState(false);

  /** @param {string} password */
  async function handleConfirm(password) {
    if (password === "") {
      setError("Enter your password to confirm.");
      setErrorIsPassword(true);
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await apiFetch("/api/v1/account", { method: "DELETE", body: { password } });
      // RequireAuth performs the redirect to /login?reason=account_deleted.
      clearSession("account_deleted");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Something went wrong. Try again in a moment.";
      setError(message);
      // A wrong password is the ordinary failure and belongs on the
      // field. It is a 400 VALIDATION_ERROR, and the server's message
      // names it.
      setErrorIsPassword(err instanceof ApiError && /password/i.test(err.message));
      setDeleting(false);
    }
  }

  return (
    <SettingsSection title="Delete your account" tone="danger">
      <p className="cc-settings__lede">
        Permanently deletes your account and every contract, report and finding in it. It
        can&apos;t be undone and we can&apos;t recover it. Download your data first if you
        want a copy.
      </p>
      <div className="cc-settings__actions">
        <Button
          variant="secondary"
          className="cc-settings__delete-trigger"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          Delete my account…
        </Button>
      </div>
      <DeleteAccountDialog
        open={open}
        deleting={deleting}
        error={error}
        errorIsPassword={errorIsPassword}
        onConfirm={handleConfirm}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
      />
    </SettingsSection>
  );
}
