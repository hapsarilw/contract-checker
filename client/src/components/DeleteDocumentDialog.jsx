import { useI18n } from "../i18n/useI18n.js";
import Dialog from "./Dialog.jsx";
import Banner from "./Banner.jsx";
import Button from "./Button.jsx";
import "./DeleteDocumentDialog.css";

/**
 * BUILD-PLAN step 37 built this inline on the report screen; step 38
 * needs the identical confirmation on the history list (FR-7.6: "the
 * same confirmation"), so it moves here rather than being copied a
 * second time — one place to get the permanence wording, the failure
 * handling, and the button pairing right.
 *
 * Deliberately thin: it owns none of the delete request itself, or what
 * happens after it succeeds (redirect, for the report; remove-from-list,
 * for history) — those differ per caller and stay there. This component
 * is only the confirmation UI and the caller's `deleting`/`error` state
 * reflected back into it.
 *
 * @param {{
 *   open: boolean,
 *   deleting: boolean,
 *   error: string | null,
 *   onConfirm: () => void,
 *   onClose: () => void,
 * }} props
 */
export default function DeleteDocumentDialog({
  open,
  deleting,
  error,
  onConfirm,
  onClose,
}) {
  const { t } = useI18n();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t.delHead}
      description={t.delBody}
      tone="danger"
    >
      {error ? (
        <Banner tone="danger" className="cc-delete-dialog__error">
          {error}
        </Banner>
      ) : null}
      <div className="cc-dialog__actions">
        <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
          {t.deleteCta}
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={deleting}>
          {t.delKeep}
        </Button>
      </div>
    </Dialog>
  );
}
