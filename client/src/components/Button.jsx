import "./Button.css";

/**
 * BUILD-PLAN step 30 — the primary/secondary/destructive button from the
 * decoded prototype (docs/design/ClauseCheck.html): e.g. the "Choose a
 * file" primary button, the "Paste the text instead" secondary button,
 * and the delete-confirmation dialog's destructive/secondary pair.
 *
 * A real `<button>`, never a styled `<div>` — keyboard operability and
 * the accessible name come from the element for free (SRS §7.15's
 * Keyboard row). `type="button"` by default so a Button dropped inside a
 * `<form>` (later steps) never submits it by accident; pass
 * `type="submit"` explicitly where that IS the intent.
 *
 * @param {{
 *   variant?: "primary" | "secondary" | "destructive",
 *   type?: "button" | "submit",
 *   className?: string,
 *   children: import("react").ReactNode,
 * } & Omit<import("react").ComponentPropsWithoutRef<"button">, "type">} props
 */
export default function Button({
  variant = "primary",
  type = "button",
  className = "",
  ...props
}) {
  return (
    <button
      type={type}
      className={`cc-button cc-button--${variant} ${className}`.trim()}
      {...props}
    />
  );
}
