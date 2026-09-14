import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import "./Dialog.css";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * BUILD-PLAN step 30 — the delete-confirmation dialog from the prototype
 * (docs/design/ClauseCheck.html), generalised into a primitive: scrim,
 * `role="dialog"` panel with a left accent border, `tone="danger"` for
 * the destructive-confirmation flavour it originally shipped as.
 *
 * The three behaviours the step calls out by name, each with a specific
 * failure mode if skipped:
 *   - Focus trap: without it, Tab from the last control inside the
 *     dialog moves focus to whatever is visually behind the scrim —
 *     invisible, but still reachable and operable.
 *   - Escape to close: the plan's explicit keyboard-operable exit.
 *   - Focus restored on close: without it, focus silently resets to
 *     `<body>`, and the next Tab press starts from the top of the page
 *     instead of picking up where the user was.
 *
 * `onClose` is read through a ref rather than depended on directly, so
 * an inline arrow function passed as `onClose` (the common case at every
 * call site) doesn't re-run the trap-setup effect — and so re-steal
 * focus — on every parent re-render while the dialog is open.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   title: string,
 *   description?: string,
 *   tone?: "default" | "danger",
 *   children?: import("react").ReactNode,
 * }} props
 */
export default function Dialog({
  open,
  onClose,
  title,
  description,
  tone = "default",
  children,
}) {
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const panel = panelRef.current;
    if (!panel) return undefined;

    const previouslyFocused = document.activeElement;

    const focusable = () =>
      /** @type {HTMLElement[]} */ (
        Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR))
      );

    // Focus moves into the dialog immediately, so both Tab/Shift+Tab and
    // a screen reader start from inside it, never from the trigger.
    (focusable()[0] ?? panel).focus();

    /** @param {KeyboardEvent} event */
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Capture phase: the trap has to see Tab/Escape before anything
    // inside the dialog's own content could stop the event first.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="cc-dialog-scrim"
      // A standard modal affordance the step doesn't name explicitly,
      // but SRS §7.15's "no keyboard trap" implies an equivalent escape
      // for a mouse user too: clicking the scrim itself (not the panel)
      // closes, the same as Escape.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`cc-dialog ${tone === "danger" ? "cc-dialog--danger" : ""}`.trim()}
      >
        <h2 className="cc-dialog__title" id={titleId}>
          {title}
        </h2>
        {description ? (
          <p className="cc-dialog__body" id={descriptionId}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
