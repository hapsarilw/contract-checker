import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";
import { useI18n } from "../i18n/useI18n.js";
import { SEVERITY_MARKS } from "../components/SeverityBadge.jsx";
import SkipLink from "../components/SkipLink.jsx";
import Banner from "../components/Banner.jsx";
import FindingCard from "./FindingCard.jsx";
import "./ReportPage.css";

/** HIGH first, matching the server's own sort (serializers.js's SEVERITY_RANK). */
const SEVERITY_ORDER = /** @type {const} */ (["HIGH", "MEDIUM", "LOW"]);

/** The prototype's CHECKED list — the eight areas the analysis reads for. */
const CHECKED_AREAS = [
  "Payment terms",
  "IP and ownership",
  "Scope and revisions",
  "Termination",
  "Liability",
  "Confidentiality",
  "Dispute resolution",
  "Anything else unusual",
];

/**
 * @typedef {{
 *   category: string,
 *   severity: "HIGH" | "MEDIUM" | "LOW",
 *   clauseExcerpt: string,
 *   explanation: string,
 *   suggestedChange: string,
 * }} Finding
 */

/**
 * BUILD-PLAN steps 35–36 — the report screen: the risk header, the
 * model's plain-language summary, the two presentation-only breakdowns
 * decision D-C approves ("the shape of it" by severity, "where the
 * problems are" by category), the severity filter, and the findings
 * themselves (or, with none, the zero-findings result). Everything below
 * the findings — missing protections, the disclaimer, delete — is step
 * 37's.
 *
 * Read docs/design/ClauseCheck.html's "3. REPORT" screen before editing
 * this file: its markup is what every class name and layout choice below
 * is matched against.
 *
 * SRS section 7 amendment (decision D-C): the category breakdown,
 * severity filter and glossary popovers have no requirement behind them
 * in the SRS text. D-C approves all three as presentation-only — computed
 * from fields the server already returns, with no change to the output
 * contract or the prompt — unlike the fourth prototype feature D-C
 * reviews (present protections), which stays deferred because it would
 * need a real model-output-schema change.
 */
export default function ReportPage() {
  const { id } = useParams();
  // `key={id}` below, not an effect that resets state on `id` change: a
  // history link to a DIFFERENT document (once step 38 exists) should
  // start this screen over completely — a fresh loading state, the
  // filter back to "all" — and the idiomatic way to get that in React is
  // to let a new `id` remount a fresh component instance, rather than an
  // effect body synchronously calling setState to reset the previous
  // one (which react-hooks/set-state-in-effect flags: it causes an extra
  // render before the fetch even starts, for state a remount gives you
  // for free).
  return <ReportPageForDocument key={id} id={id} />;
}

/** @param {{ id: string | undefined }} props */
function ReportPageForDocument({ id }) {
  const { t } = useI18n();
  const [state, setState] = useState(
    /** @type {{ status: "loading" | "loaded" | "error", document: object | null, analysis: object | null, error: unknown }} */ ({
      status: "loading",
      document: null,
      analysis: null,
      error: null,
    }),
  );
  const [filter, setFilter] = useState(
    /** @type {"all" | "HIGH" | "MEDIUM" | "LOW"} */ ("all"),
  );

  // `cancelled` guards against setting state from a request this
  // component has since been unmounted for (a fast id change while the
  // previous fetch is still in flight) — the same pattern step 34's
  // AnalyzingPanel uses.
  useEffect(() => {
    let cancelled = false;

    apiFetch(`/api/v1/documents/${id}`).then(
      (body) => {
        if (cancelled) return;
        const typed = /** @type {{ document: object, analysis: object | null }} */ (body);
        setState({
          status: "loaded",
          document: typed.document,
          analysis: typed.analysis,
          error: null,
        });
      },
      (err) => {
        if (cancelled) return;
        setState({ status: "error", document: null, analysis: null, error: err });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.status === "loading") {
    return (
      <div className="cc-report">
        <SkipLink />
        <main id="main" tabIndex={-1}>
          <h1 className="cc-sr-only">{t.overallRisk}</h1>
          <p role="status" aria-live="polite" className="cc-report__loading">
            Loading the report…
          </p>
        </main>
      </div>
    );
  }

  if (state.status === "error") {
    const message =
      state.error instanceof ApiError
        ? state.error.message
        : "Something went wrong loading this report. Try again in a moment.";
    return (
      <div className="cc-report">
        <SkipLink />
        <main id="main" tabIndex={-1}>
          <h1 className="cc-report__error-title">We couldn’t load this report.</h1>
          <Banner tone="danger">{message}</Banner>
          <Link to="/" className="cc-report__back-link">
            Back to upload
          </Link>
        </main>
      </div>
    );
  }

  const { document, analysis } = state;

  // A document can exist here with no COMPLETED analysis — visited
  // directly by id before step 33's upload flow ever ran analyze, or
  // after an analyze attempt that failed and the user never retried.
  // Real polish for this (a "resume where you left off" action) is
  // step 38/39's job, once history links into this route; this is only
  // the guard that keeps that case from reading `analysis.findings` on
  // a null or non-COMPLETED analysis and crashing.
  if (!analysis || analysis.status !== "COMPLETED") {
    return (
      <div className="cc-report">
        <SkipLink />
        <main id="main" tabIndex={-1}>
          <h1 className="cc-report__error-title">
            This document hasn’t been checked yet.
          </h1>
          <p className="cc-report__loading">
            {document.filename ?? "Pasted text"} doesn’t have a completed analysis to
            show.
          </p>
          <Link to="/" className="cc-report__back-link">
            Back to upload
          </Link>
        </main>
      </div>
    );
  }

  // The server's deterministic overallRisk (PRD §7 / FR-3.9) — never
  // modelRisk, which serializeAnalysis (server/src/lib/serializers.js)
  // never even sends: there is no field here it could accidentally read.
  const riskKey = /** @type {"HIGH" | "MEDIUM" | "LOW"} */ (analysis.overallRisk);

  // FR-7.5 is a client requirement ("Findings render in severity order"),
  // so it's enforced here rather than inherited from the server's sort.
  // Array.prototype.sort is stable, so the server's order within one
  // severity survives.
  const findings = [.../** @type {Finding[]} */ (analysis.findings)].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const hasFindings = findings.length > 0;

  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const maxCount = Math.max(1, counts.HIGH, counts.MEDIUM, counts.LOW);

  /** @type {Record<string, number>} */
  const catCounts = {};
  for (const finding of findings) {
    catCounts[finding.category] = (catCounts[finding.category] ?? 0) + 1;
  }

  // Each card keeps its position in the FULL list as its React key, not
  // its position in the filtered one. Findings have no id, and an index
  // into the filtered list would hand one card's local state (a "Copied"
  // confirmation, an open glossary term) to whichever card lands in its
  // slot after the filter changes.
  const shownList = findings
    .map((finding, position) => ({ finding, position }))
    .filter(({ finding }) => filter === "all" || finding.severity === filter);
  const shownCountText =
    filter === "all"
      ? t.showingAll + findings.length
      : t.showing + shownList.length + t.of + findings.length;

  const riskCountText =
    findings.length === 0
      ? t.noneFlagged
      : findings.length + " " + t.findingWord[findings.length === 1 ? 0 : 1];

  const docMeta =
    (document.filename ?? "Pasted text") +
    " · " +
    document.wordCount.toLocaleString("en-US") +
    " words · checked " +
    new Date(analysis.createdAt).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

  return (
    <div className="cc-report">
      <SkipLink />
      {/* Points at "/" (upload), not the prototype's history screen: /documents
          doesn't exist as a route until step 38, and there is no app-chrome nav
          yet to reach it from either (step 39). A real "back to history" link
          replaces this once both exist. */}
      <Link to="/" className="cc-report__back-link">
        {t.back}
      </Link>

      <main id="main" tabIndex={-1}>
        <div className="cc-report__masthead">
          <div className="cc-report__meta">{docMeta}</div>

          <div className="cc-report__top">
            <div className={`cc-report__risk cc-report__risk--${riskKey.toLowerCase()}`}>
              <p className="cc-report__risk-eyebrow">{t.overallRisk}</p>
              {/* The prototype's masthead has no heading at all on this screen
                  (docs/design/ClauseCheck.html jumps straight to the findings
                  h2) — a real gap against SRS §7.15's "one h1 per page,
                  correct heading order." This is that h1: the risk value reads
                  naturally as the report's title, and the aria-label carries
                  the "Overall risk:" context a screen-reader user jumping here
                  by heading navigation wouldn't otherwise get from the visible
                  text alone. */}
              <h1
                className="cc-report__risk-value"
                aria-label={`${t.overallRisk}: ${t.severity[riskKey]}`}
              >
                {t.severity[riskKey]}
              </h1>
              <div className="cc-report__risk-sub">
                <span className="cc-report__risk-mark" aria-hidden="true">
                  {SEVERITY_MARKS[riskKey.toLowerCase()]}
                </span>
                <span className="cc-report__risk-count">{riskCountText}</span>
              </div>
            </div>

            <p className="cc-report__summary">{analysis.summary}</p>
          </div>

          {hasFindings ? (
            <div className="cc-report__breakdown">
              <div className="cc-report__breakdown-col">
                <h2 className="cc-report__breakdown-title">{t.shape}</h2>
                <div className="cc-report__sev-rows">
                  {SEVERITY_ORDER.map((key) => (
                    <div className="cc-report__sev-row" key={key}>
                      <span
                        className={`cc-report__sev-mark cc-report__sev-mark--${key.toLowerCase()}`}
                        aria-hidden="true"
                      >
                        {SEVERITY_MARKS[key.toLowerCase()]}
                      </span>
                      <span className="cc-report__sev-row-label">
                        {counts[key] + " " + t.severity[key].toLowerCase()}
                      </span>
                      <span className="cc-report__sev-bar-track" aria-hidden="true">
                        <span
                          className={`cc-report__sev-bar-fill cc-report__sev-bar-fill--${key.toLowerCase()}`}
                          style={{
                            width: Math.round((counts[key] / maxCount) * 100) + "%",
                          }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="cc-report__breakdown-col cc-report__breakdown-col--where">
                <h2 className="cc-report__breakdown-title">{t.where}</h2>
                <div className="cc-report__cat-chips">
                  {Object.entries(catCounts).map(([category, count]) => (
                    <span className="cc-report__cat-chip" key={category}>
                      {(t.categories[category] ?? t.categories.OTHER) + " · " + count}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {hasFindings ? (
          <>
            <div className="cc-report__findings-head">
              <div>
                <h2 className="cc-report__findings-title">{t.findingsHead}</h2>
                <div className="cc-report__order-note">
                  {t.orderNote} ·{" "}
                  <span role="status" aria-live="polite">
                    {shownCountText}
                  </span>
                </div>
              </div>

              <div
                className="cc-report__filters"
                role="group"
                aria-label={t.findingsHead}
              >
                <button
                  type="button"
                  className={`cc-report__filter ${filter === "all" ? "cc-report__filter--active" : ""}`.trim()}
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  {t.filterAll + " " + findings.length}
                </button>
                {SEVERITY_ORDER.filter((key) => counts[key] > 0).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`cc-report__filter ${filter === key ? "cc-report__filter--active" : ""}`.trim()}
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                  >
                    {t.severity[key] + " " + counts[key]}
                  </button>
                ))}
              </div>
            </div>

            {/* SRS §7.15: "findings as a semantic list" — an ordered one,
                since the order (highest severity first) is itself meaning. */}
            <ol className="cc-report__findings">
              {shownList.map(({ finding, position }) => (
                <li key={position}>
                  <FindingCard finding={finding} />
                </li>
              ))}
            </ol>
          </>
        ) : (
          // Fixture 03 is a release gate (PRD §11.1), and a clean contract is
          // the result the user hoped for — so this is a result card with its
          // own heading, not a Banner, not an alert role, and not an absence
          // of content that reads like something failed to load.
          <div className="cc-report__clean">
            <h2 className="cc-report__clean-title">
              Nothing in this contract needs a second look.
            </h2>
            <p className="cc-report__clean-body">
              That’s an uncommon result, so here’s the work behind it. Each area below was
              read against the clauses actually in your document, and none of them turned
              up wording that works against you.
            </p>
            <ul className="cc-report__checked">
              {CHECKED_AREAS.map((area) => (
                <li className="cc-report__checked-item" key={area}>
                  <span className="cc-report__checked-mark" aria-hidden="true">
                    ✓
                  </span>
                  {area}
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}
