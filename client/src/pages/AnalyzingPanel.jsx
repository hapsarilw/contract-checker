import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api/client.js";
import { resolveAnalyzeError } from "./analyzeErrors.js";
import Button from "../components/Button.jsx";
import SkipLink from "../components/SkipLink.jsx";
import "./AnalyzingPanel.css";

/**
 * BUILD-PLAN step 34 — the prototype's four stages, exact labels and
 * notes (docs/design/ClauseCheck.html's STAGES array).
 */
const STAGES = [
  {
    label: "Reading the document",
    note: "Pulling the text out and checking it looks like a contract.",
  },
  {
    label: "Examining the clauses",
    note: "Payment, ownership, scope, termination, liability, confidentiality, disputes.",
  },
  {
    label: "Checking each quote against your document",
    note: "Anything we can't find word-for-word in your file gets dropped.",
  },
  {
    label: "Checking what's missing",
    note: "Comparing against the protections a freelance contract normally has.",
  },
];

/**
 * FR-7.4: "usually about 30 seconds," evenly split across the four
 * stages — there is no per-stage timing data to weight this by (Phase
 * 1's analyze call is one synchronous request with no intermediate
 * server state, SRS §2.2), so an even split is what "usually about 30
 * seconds" honestly becomes without inventing a distribution this app
 * doesn't actually know. This timer is cosmetic pacing, never a
 * completion signal: the REAL result is whatever the analyze request
 * below resolves with, whenever that actually happens, not when this
 * interval runs out.
 */
const STAGE_DURATION_MS = 30_000 / STAGES.length;

/** A real browser-navigation guard (FR-7.3) — installed only while the analyze request is in flight. */
function warnBeforeUnload(event) {
  event.preventDefault();
  event.returnValue = "";
}

/**
 * BUILD-PLAN step 34 — the prototype's "2. ANALYZING" screen: the
 * client-side-timer stage list (FR-7.4), or its error state (the
 * prototype's ANALYZE_ERRORS, analyzeErrors.js), depending on how the
 * real POST /api/v1/documents/:id/analyze call resolves.
 *
 * The document behind `documentId` already exists (step 33's upload
 * already succeeded) — an analyze failure never sends the user back to
 * the upload form the way an upload failure does; "Try again" retries
 * analyze on the SAME document, "Back to upload" is the only way out of
 * this screen entirely.
 *
 * @param {{
 *   documentId: string,
 *   meta: { filename: string | null, wordCount: number },
 *   onComplete: (analysis: unknown) => void,
 *   onBackToUpload: () => void,
 * }} props
 */
export default function AnalyzingPanel({ documentId, meta, onComplete, onBackToUpload }) {
  const [stageIndex, setStageIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [analyzeError, setAnalyzeError] = useState(
    /** @type {{ code: string, title: string, body: string, primary: string } | null} */ (
      null
    ),
  );

  // The stage timer: advances every STAGE_DURATION_MS, clamped at the
  // last stage rather than looping or auto-completing — there is
  // nothing further to describe once "Checking what's missing" is
  // reached, and the real request may still be running past it. Reset
  // to 0 on every new attempt (a retry restarts the narrative, matching
  // a fresh analyze call actually starting over).
  useEffect(() => {
    if (analyzeError) return undefined;
    const interval = setInterval(() => {
      setStageIndex((current) => Math.min(current + 1, STAGES.length - 1));
    }, STAGE_DURATION_MS);
    return () => clearInterval(interval);
    // `attempt` is read only as a dependency (the reset signal that
    // restarts this effect on retry), never inside the closure itself —
    // no eslint-disable needed here, unlike the effect below.
  }, [attempt, analyzeError]);

  // The real analyze call. Runs once per `attempt` (the initial mount,
  // then once per "Try again"); analyzeError !== null stops it from
  // re-running while the error card is showing.
  useEffect(() => {
    if (analyzeError) return undefined;
    let cancelled = false;
    window.addEventListener("beforeunload", warnBeforeUnload);

    apiFetch(`/api/v1/documents/${documentId}/analyze`, { method: "POST" }).then(
      (body) => {
        if (cancelled) return;
        onComplete(/** @type {{ analysis: unknown }} */ (body).analysis);
      },
      (err) => {
        if (cancelled) return;
        if (!(err instanceof ApiError)) throw err;
        setAnalyzeError(resolveAnalyzeError(err));
      },
    );

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onComplete is a stable callback from the parent; re-running on identity churn would re-issue the request
  }, [documentId, attempt, analyzeError]);

  if (analyzeError) {
    return (
      <div className="cc-analyzing">
        <SkipLink />
        <div className="cc-analyzing__frame">
          <main id="main" tabIndex={-1}>
            <div className="cc-analyzing-error">
              <h1 className="cc-analyzing-error__title">{analyzeError.title}</h1>
              <p className="cc-analyzing-error__body">{analyzeError.body}</p>
              <div className="cc-analyzing-error__actions">
                <Button
                  onClick={() => {
                    setAnalyzeError(null);
                    setStageIndex(0);
                    setAttempt((n) => n + 1);
                  }}
                >
                  {analyzeError.primary}
                </Button>
                <Button variant="secondary" onClick={onBackToUpload}>
                  Back to upload
                </Button>
              </div>
              <div className="cc-analyzing-error__code">{analyzeError.code}</div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="cc-analyzing">
      <SkipLink />
      <div className="cc-analyzing__frame">
        <main id="main" tabIndex={-1}>
          <div className="cc-analyzing__meta">
            {(meta.filename ?? "Pasted text") + " · " + meta.wordCount + " words"}
          </div>
          <h1 className="cc-analyzing__title">Reading your contract</h1>
          <p className="cc-analyzing__subhead">
            This usually takes about 30 seconds. Keep this tab open. Closing it stops the
            check.
          </p>

          {/* FR-7.4 / SRS §7.15's Progress row: role="status" + aria-live
              "polite" so a stage transition is announced without
              interrupting whatever the user is doing, and without ever
              moving focus here — nothing in this component calls .focus(). */}
          <div className="cc-analyzing__stages" role="status" aria-live="polite">
            {STAGES.map((stage, index) => {
              const state =
                index < stageIndex
                  ? "done"
                  : index === stageIndex
                    ? "current"
                    : "pending";
              const mark = state === "done" ? "✓" : state === "current" ? "●" : "○";
              return (
                <div
                  className="cc-analyzing__stage"
                  key={stage.label}
                  aria-current={state === "current" ? "step" : undefined}
                >
                  <span
                    className={`cc-analyzing__stage-mark cc-analyzing__stage-mark--${state}`}
                    aria-hidden="true"
                  >
                    {mark}
                  </span>
                  <div>
                    <div
                      className={`cc-analyzing__stage-label cc-analyzing__stage-label--${state}`}
                    >
                      {stage.label}
                    </div>
                    {state === "current" ? (
                      <div className="cc-analyzing__stage-note">{stage.note}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="cc-analyzing__honesty-note">
            These steps describe the work being done, not a live count. We will not show
            you a percentage we'd have to invent.
          </p>
        </main>
      </div>
    </div>
  );
}
