import { Fragment } from "react";
import { useI18n } from "../i18n/useI18n.js";
import SeverityBadge from "../components/SeverityBadge.jsx";
import CopyButton from "../components/CopyButton.jsx";
import GlossaryTerm from "../components/GlossaryTerm.jsx";
import { splitGlossaryTerms } from "./glossaryTerms.js";
import "./FindingCard.css";

/**
 * BUILD-PLAN step 36 — one finding, matched to the prototype's card
 * (docs/design/ClauseCheck.html's `<article>` inside the findings sheet).
 *
 * Every string on this card except the section labels is MODEL OUTPUT —
 * SRS §2.4's fourth trust boundary. All of it reaches the DOM as React
 * text nodes: the excerpt, the explanation (split into text and
 * glossary-term segments, each still rendered as text), the suggested
 * change, and the copied text. There is no markup path here to guard,
 * and `dangerouslySetInnerHTML` is lint-banned repo-wide (FR-7.8), so
 * none can be added quietly.
 *
 * `category` falls back to OTHER's label rather than rendering
 * `undefined`: the server validates the enum today, but a label lookup
 * that can silently print nothing is worth one `??`.
 *
 * @param {{
 *   finding: {
 *     category: string,
 *     severity: "HIGH" | "MEDIUM" | "LOW",
 *     clauseExcerpt: string,
 *     explanation: string,
 *     suggestedChange: string,
 *   },
 * }} props
 */
export default function FindingCard({ finding }) {
  const { t } = useI18n();
  const severity = /** @type {"high" | "medium" | "low"} */ (
    finding.severity.toLowerCase()
  );

  return (
    <article className={`cc-finding cc-finding--${severity}`}>
      <div className="cc-finding__head">
        <h3 className="cc-finding__category">
          {t.categories[finding.category] ?? t.categories.OTHER}
        </h3>
        <SeverityBadge
          variant="inline"
          severity={severity}
          label={t.findingSeverity[finding.severity]}
          className="cc-finding__severity"
        />
      </div>

      <div className="cc-finding__quote-col">
        <p className="cc-finding__eyebrow cc-finding__eyebrow--quote">{t.quotedFrom}</p>
        <blockquote className="cc-finding__quote">“{finding.clauseExcerpt}”</blockquote>
      </div>

      <div className="cc-finding__detail-col">
        <p className="cc-finding__eyebrow">{t.why}</p>
        <p className="cc-finding__why">
          {splitGlossaryTerms(finding.explanation).map((segment, index) =>
            segment.type === "term" ? (
              <GlossaryTerm
                key={index}
                term={segment.text}
                meaning={t.glossary[segment.key]}
              />
            ) : (
              <Fragment key={index}>{segment.text}</Fragment>
            ),
          )}
        </p>

        <p className="cc-finding__eyebrow">{t.ask}</p>
        <p className="cc-finding__ask">{finding.suggestedChange}</p>
        <CopyButton
          text={finding.suggestedChange}
          label={t.copyLabel}
          copiedLabel={t.copiedLabel}
          announcement={t.copiedNote}
          visibleAnnouncement
        />
      </div>
    </article>
  );
}
