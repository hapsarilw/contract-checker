import { useEffect, useRef, useState } from "react";
import "./CopyButton.css";

const RESET_AFTER_MS = 2000;

/**
 * BUILD-PLAN step 30 — the "Copy this ask" button from the prototype
 * (docs/design/ClauseCheck.html): copies `text`, swaps its icon/label/
 * colour to a confirmed state for a couple of seconds, then reverts.
 *
 * SRS §7.15's "Copy control" row, the two things it calls out
 * specifically:
 *   - Keyboard-operable: a real `<button>`, so this is free — it needs
 *     no special handling to get here, only to not be undone by
 *     rendering something else instead.
 *   - Confirmation announced via `aria-live="polite"`, not only shown:
 *     the visible label already changes (copyLabel -> copiedLabel), but
 *     a screen reader user tabbing past a button whose label silently
 *     changed underneath them gets no signal at all. `announcement` is
 *     rendered into a visually-hidden, polite live region instead, and
 *     ONLY set after a successful copy — it starts empty, so nothing is
 *     announced on mount, and the button itself is never `.focus()`ed,
 *     so confirming a copy never steals focus from wherever it already
 *     was.
 *
 * A failed copy (clipboard permission denied, no Clipboard API, a
 * non-secure context) leaves the button in its normal state and
 * announces nothing — a silent "Copied" for a copy that didn't happen
 * would be worse than no feedback.
 *
 * `visibleAnnouncement` shows that same live region on screen instead of
 * hiding it — the finding card's "Copied — paste it into your reply to
 * the client." note (step 36). Same element either way, so the region is
 * in the DOM, empty, before any copy, which is what makes its later
 * content announce reliably.
 *
 * @param {{
 *   text: string,
 *   label: string,
 *   copiedLabel: string,
 *   announcement: string,
 *   visibleAnnouncement?: boolean,
 *   className?: string,
 * }} props
 */
export default function CopyButton({
  text,
  label,
  copiedLabel,
  announcement,
  visibleAnnouncement = false,
  className = "",
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef(
    /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined),
  );

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No Clipboard API, permission denied, or a non-secure context —
      // nothing below runs, so the button stays in its normal state and
      // announces nothing false.
      return;
    }
    setCopied(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), RESET_AFTER_MS);
  }

  return (
    <>
      <button
        type="button"
        className={`cc-copy-button ${copied ? "cc-copy-button--copied" : ""} ${className}`.trim()}
        onClick={handleClick}
      >
        <span className="cc-copy-button__icon" aria-hidden="true">
          {copied ? "✓" : "⧉"}
        </span>
        {copied ? copiedLabel : label}
      </button>
      <span
        className={visibleAnnouncement ? "cc-copy-button__note" : "cc-sr-only"}
        role="status"
        aria-live="polite"
      >
        {copied ? announcement : ""}
      </span>
    </>
  );
}
