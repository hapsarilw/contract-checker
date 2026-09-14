import { useId } from "react";
import "./TextField.css";

/**
 * BUILD-PLAN step 30 — a label programmatically associated with its
 * control (`<label htmlFor>` / `id`, never a wrapping `<label>` alone,
 * which some assistive tech announces inconsistently for styled inputs)
 * and an error slot linked via `aria-describedby`, per SRS §7.15's Forms
 * row: "Labels programmatically associated; errors linked via
 * aria-describedby; aria-invalid set; error text names the fix."
 *
 * `multiline` renders a `<textarea>` in the serif body face, matching the
 * prototype's "paste the contract text" field — everything else (label,
 * hint, error, aria wiring) is identical between the two, so this stays
 * one component rather than TextField plus a near-duplicate TextArea.
 *
 * Two near-identical `multiline ? <textarea> : <input>` JSX branches
 * below, not one `<Control>` variable holding `"input" | "textarea"`:
 * TypeScript can check `<input>`'s and `<textarea>`'s props (their
 * `onChange` handlers alone take different element types) but not a tag
 * whose name is itself a runtime union — spreading the same `rest` onto
 * a dynamic tag can't be checked against either concrete element, only
 * against their incompatible intersection. Two typed branches instead of
 * one untyped one.
 *
 * @param {{
 *   label: string,
 *   id?: string,
 *   hint?: string,
 *   error?: string,
 *   multiline?: boolean,
 *   className?: string,
 * } & (import("react").ComponentPropsWithoutRef<"input"> | import("react").ComponentPropsWithoutRef<"textarea">)} props
 */
export default function TextField({
  label,
  id,
  hint,
  error,
  multiline = false,
  className = "",
  ...rest
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  // Both, when both are present: the hint still orients the field, the
  // error still explains what's wrong — losing either narrows what's
  // announced to less than the sighted layout shows.
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const controlClassName =
    `cc-field__control ${multiline ? "cc-field__control--multiline" : ""}`.trim();

  // `rest`'s declared type is the UNION of both elements' props
  // (whichever one a caller actually meant), so it isn't narrowed to
  // either concrete element on its own — cast once per element here,
  // as plain statements, rather than inline inside the JSX spread below:
  // Prettier reformats a JSDoc type-cast comment sitting inside a JSX
  // spread `{...( /** @type {...} */ (x))}` in a way that silently
  // detaches the comment from the expression it was casting.
  const textareaProps =
    /** @type {import("react").ComponentPropsWithoutRef<"textarea">} */ (rest);
  const inputProps = /** @type {import("react").ComponentPropsWithoutRef<"input">} */ (
    rest
  );

  return (
    <div className={`cc-field ${className}`.trim()}>
      <label className="cc-field__label" htmlFor={fieldId}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={fieldId}
          className={controlClassName}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          {...textareaProps}
        />
      ) : (
        <input
          id={fieldId}
          className={controlClassName}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          {...inputProps}
        />
      )}
      {hint ? (
        <p className="cc-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="cc-field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
