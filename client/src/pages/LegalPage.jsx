import { Link } from "react-router";
import SkipLink from "../components/SkipLink.jsx";
import SiteFooter from "../components/SiteFooter.jsx";
import Banner from "../components/Banner.jsx";
import { LEGAL_UPDATED, unresolved } from "../legal/content.js";
import "./LegalPage.css";

/**
 * BUILD-PLAN step 74: /privacy, /terms and /subprocessors. Public: a
 * signed-out visitor deciding whether to sign up is exactly who needs
 * them. Content is ../legal/content.js; this only lays it out.
 *
 * While the document still holds a placeholder for the owner to fill in,
 * a draft notice says so at the top and lists what is missing. It is
 * computed from the content (unresolved()), so it disappears only when
 * the last placeholder does, and never because someone forgot to remove it.
 *
 * @param {{ doc: import("../legal/content.js").LegalDocument }} props
 */
export default function LegalPage({ doc }) {
  const missing = unresolved(doc);
  return (
    <div className="cc-legal-page">
      <SkipLink />
      <header className="cc-legal-page__header">
        <Link to="/" className="cc-legal-page__brand">
          <span className="cc-legal-page__brand-mark" aria-hidden="true" />
          ClauseCheck
        </Link>
      </header>
      <main id="main" tabIndex={-1} className="cc-legal-page__main">
        <h1 className="cc-legal-page__title">{doc.title}</h1>
        <p className="cc-legal-page__meta">Last updated {LEGAL_UPDATED}</p>
        {missing.length > 0 ? (
          <Banner
            tone="warning"
            role="group"
            title="Draft: not yet in force"
            className="cc-legal-page__draft"
          >
            <p>
              This document is not final. It still needs the following before it takes
              effect:
            </p>
            <ul>
              {missing.map((item) => (
                <li key={item}>{item.slice(1, -1).toLowerCase()}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        <p className="cc-legal-page__summary">{doc.summary}</p>
        {doc.sections.map((section, i) => {
          const id = `${doc.slug}-section-${i + 1}`;
          return (
            <section key={id} aria-labelledby={id} className="cc-legal-page__section">
              <h2 id={id} className="cc-legal-page__heading">
                {section.heading}
              </h2>
              {section.blocks.map((block, j) => (
                <Block key={j} block={block} caption={section.heading} />
              ))}
            </section>
          );
        })}
      </main>
      <SiteFooter />
    </div>
  );
}

/**
 * @param {{ block: import("../legal/content.js").Block, caption: string }} props
 */
function Block({ block, caption }) {
  if (typeof block === "string") return <p className="cc-legal-page__text">{block}</p>;
  if ("list" in block) {
    return (
      <ul className="cc-legal-page__list">
        {block.list.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  return (
    // Focusable and labelled because at 320 px it scrolls sideways, and a
    // region that scrolls must be reachable by keyboard (axe
    // scrollable-region-focusable; WCAG 2.1.1).
    <div
      className="cc-legal-page__table-wrap"
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table className="cc-legal-page__table">
        <caption className="cc-sr-only">{caption}</caption>
        <thead>
          <tr>
            {block.table.head.map((cell) => (
              <th key={cell} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.table.rows.map((row) => (
            <tr key={row.join("|")}>
              {row.map((cell, k) =>
                k === 0 ? (
                  <th key={k} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={k}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
