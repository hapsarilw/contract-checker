import { useState } from "react";
import Banner from "./Banner.jsx";
import Button from "./Button.jsx";
import Dialog from "./Dialog.jsx";
import TextField from "./TextField.jsx";
import "./DeleteAccountDialog.css";

/**
 * FR-4.6 / PRD D2: account deletion, confirmed by re-entering the
 * password. The register is the delete-CONTRACT dialog's, one level up:
 * it cannot be undone and it cannot be recovered, and it says so before
 * it does anything.
 *
 * "STATES EXACTLY WHAT WILL BE DESTROYED" is the requirement that shapes
 * the copy. The list below is what the server's one transaction actually
 * removes (services/account.js: the User row and, by ON DELETE CASCADE,
 * its documents, analyses, findings and auth tokens) and nothing it does
 * not. Two things are said that a vaguer dialog would leave out, both
 * because they are true and both because a person deciding this is
 * entitled to them: backups keep a copy for up to 30 days before they age
 * out (PRD §12.4 refuses to claim instant erasure everywhere), and a
 * record that a deletion happened is kept, with nothing in it that
 * identifies the person (NFR-2.12, FR-4.6).
 *
 * The password box is the last step, not the first: someone who has read
 * the list and still types their password has meant it.
 *
 * `error` is the server's own message, shown against the password field
 * when it is about the password ("That is not your current password.")
 * and in a banner otherwise.
 *
 * @param {{
 *   open: boolean,
 *   deleting: boolean,
 *   error: string | null,
 *   errorIsPassword: boolean,
 *   onConfirm: (password: string) => void,
 *   onClose: () => void,
 * }} props
 */
export default function DeleteAccountDialog({
  open,
  deleting,
  error,
  errorIsPassword,
  onConfirm,
  onClose,
}) {
  const [password, setPassword] = useState("");

  function close() {
    setPassword("");
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Delete your account permanently?"
      description="This can’t be undone, and we won’t be able to recover any of it for you."
      tone="danger"
    >
      <p className="cc-delete-account__lead">Deleting your account destroys:</p>
      <ul className="cc-delete-account__list">
        <li>your account and your sign-in</li>
        <li>every contract you uploaded, including its full text</li>
        <li>every report and every finding</li>
        <li>any reset or verification links still waiting to be used</li>
      </ul>
      <p className="cc-delete-account__fine">
        Backups keep a copy for up to 30 days before they age out. We keep a note that a
        deletion happened, with nothing in it that identifies you. A confirmation goes to
        your email.
      </p>

      {error && !errorIsPassword ? (
        <Banner tone="danger" className="cc-delete-account__error">
          {error}
        </Banner>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!deleting) onConfirm(password);
        }}
        noValidate
      >
        <TextField
          label="Enter your password to confirm"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errorIsPassword && error ? error : undefined}
        />
        <div className="cc-dialog__actions cc-delete-account__actions">
          <Button type="submit" variant="destructive" disabled={deleting}>
            {deleting ? "Deleting…" : "Delete everything permanently"}
          </Button>
          <Button variant="secondary" onClick={close} disabled={deleting}>
            Keep my account
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
