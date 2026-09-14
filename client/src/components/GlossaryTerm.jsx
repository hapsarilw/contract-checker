import { useEffect, useId, useRef, useState } from "react";
import "./GlossaryTerm.css";

/** The prototype's popover width (276px) plus its 20px of breathing room. */
const POPOVER_SPAN_PX = 296;

/**
 * BUILD-PLAN step 36 / decision D-C — a glossary popover on one term
 * inside a finding's explanation, ported from the prototype's GLOSS
 * markup (docs/design/ClauseCheck.html).
 *
 * A disclosure, not a tooltip: a real `<button>` with `aria-expanded`
 * and `aria-controls`, whose content sits right after it in the DOM so
 * reading order is unchanged. Opened by click (so Enter/Space too),
 * closed by a second click, Escape, or a click outside.
 *
 * Deliberately NOT ported: the prototype also opens on hover and on
 * focus. Content that appears on hover or focus has to be dismissible,
 * hoverable and persistent (WCAG 1.4.13), and content that appears
 * merely because Tab passed over a word is a surprise for a keyboard
 * user moving through a card — an explicit toggle meets "keyboard-
 * reachable and Escape-dismissible" without either problem.
 *
 * Below 600px the popover renders inline under the term (CSS), which is
 * the prototype's own mobile treatment; above it, it flips to open
 * leftward when opening rightward would run past the viewport — also the
 * prototype's behaviour, and what keeps SRS §7.15's no-horizontal-scroll
 * requirement true with a popover open.
 *
 * @param {{ term: string, meaning: string }} props
 */
export default function GlossaryTerm({ term, meaning }) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const wrapperRef = useRef(/** @type {HTMLSpanElement | null} */ (null));
  const buttonRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const popoverId = useId();

  useEffect(() => {
    if (!open) return undefined;

    /** @param {KeyboardEvent} event */
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    /** @param {MouseEvent} event */
    function onMouseDown(event) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(/** @type {Node} */ (event.target))
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  /** @param {import("react").MouseEvent<HTMLButtonElement>} event */
  function handleClick(event) {
    if (!open) {
      const rect = event.currentTarget.getBoundingClientRect();
      setFlip(rect.left + POPOVER_SPAN_PX > document.documentElement.clientWidth);
    }
    setOpen((current) => !current);
  }

  return (
    <span className="cc-glossary" ref={wrapperRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`cc-glossary__term ${open ? "cc-glossary__term--open" : ""}`.trim()}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={handleClick}
      >
        {term}
      </button>
      <span
        id={popoverId}
        className={`cc-glossary__popover ${flip ? "cc-glossary__popover--flip" : ""}`.trim()}
        hidden={!open}
      >
        <span className="cc-glossary__popover-term">{term}</span>
        <span className="cc-glossary__popover-meaning">{meaning}</span>
      </span>
    </span>
  );
}
