import "./Card.css";

/**
 * BUILD-PLAN step 30 — the card surface every screen composes into: the
 * report header, the auth card, the upload panel. `accent` is the
 * brand-colour top stripe the prototype puts on its primary card per
 * screen; a plain Card is a bare container for secondary content.
 *
 * @param {{
 *   accent?: boolean,
 *   className?: string,
 *   children?: import("react").ReactNode,
 * } & import("react").ComponentPropsWithoutRef<"div">} props
 */
export default function Card({ accent = false, className = "", ...rest }) {
  return (
    <div
      className={`cc-card ${accent ? "cc-card--accent" : ""} ${className}`.trim()}
      {...rest}
    />
  );
}
