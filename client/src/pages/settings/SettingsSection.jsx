import { useId } from "react";

/**
 * One block of the settings screen: an `<h2>` and what belongs under it.
 * `aria-labelledby` ties the region to its own heading, so a screen-reader
 * user can list the page's sections by name and jump between them.
 *
 * @param {{ title: string, tone?: "default" | "danger", children: import("react").ReactNode }} props
 */
export default function SettingsSection({ title, tone = "default", children }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={`cc-settings__section ${tone === "danger" ? "cc-settings__section--danger" : ""}`.trim()}
    >
      <h2 className="cc-settings__heading" id={headingId}>
        {title}
      </h2>
      {children}
    </section>
  );
}
