import "./Banner.css";

const DEFAULT_ROLE = {
  danger: "alert",
  warning: "alert",
  info: "status",
};

/**
 * BUILD-PLAN step 30 — the upload-error banner from the prototype
 * (docs/design/ClauseCheck.html: left-accent border, tinted background,
 * a bold title over a secondary-ink body), generalised with a `tone`
 * prop — `danger` is that exact banner; `warning` reuses the medium-
 * severity tint for FR-7.10's degraded-mode notice; `info` is neutral.
 *
 * `danger`/`warning` default to `role="alert"` (assertive — something
 * needs the user's attention now); `info` defaults to `role="status"`
 * (polite). Either can be overridden, but a screen introducing a new
 * tone combination should have a reason to pick a different role, not
 * just accept whichever this component happened to default to.
 * `role="group"` is the silent one: for a standing notice that contains
 * its own live region (VerifyEmailBanner's resend status), where making
 * the container live as well would announce everything twice.
 *
 * @param {{
 *   tone?: "danger" | "warning" | "info",
 *   title?: string,
 *   role?: "alert" | "status" | "group",
 *   className?: string,
 *   children?: import("react").ReactNode,
 * } & import("react").ComponentPropsWithoutRef<"div">} props
 */
export default function Banner({
  tone = "info",
  title,
  role,
  className = "",
  children,
  ...rest
}) {
  return (
    <div
      role={role ?? DEFAULT_ROLE[tone]}
      className={`cc-banner cc-banner--${tone} ${className}`.trim()}
      {...rest}
    >
      {title ? <p className="cc-banner__title">{title}</p> : null}
      <div className="cc-banner__body">{children}</div>
    </div>
  );
}
