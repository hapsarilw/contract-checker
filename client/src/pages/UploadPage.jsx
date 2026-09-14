import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";
import { checkFileBeforeUpload, resolveServerUploadError } from "./uploadErrors.js";
import SkipLink from "../components/SkipLink.jsx";
import Tabs from "../components/Tabs.jsx";
import Banner from "../components/Banner.jsx";
import Button from "../components/Button.jsx";
import TextField from "../components/TextField.jsx";
import "./UploadPage.css";

/** FR-2.2, matching server/src/middleware/upload.js's MAX_UPLOAD_BYTES exactly. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** FR-2.5 / FR-2.6, matching server/src/config.js's defaults — client-side, informational only. */
const MIN_DOCUMENT_WORDS = 200;
const MAX_DOCUMENT_WORDS = 4000;

const TABS = [
  { id: "file", label: "Upload a file" },
  { id: "paste", label: "Paste the text" },
];

/** A real browser-navigation guard (FR-7.3) — installed only while a request is in flight. */
function warnBeforeUnload(event) {
  event.preventDefault();
  // Chrome requires returnValue to be set; the string itself is never
  // shown — every browser supplies its own generic confirmation text.
  event.returnValue = "";
}

/** @param {string} text */
function countWords(text) {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * BUILD-PLAN step 33 — the prototype's "1. UPLOAD" screen
 * (docs/design/ClauseCheck.html), FR-7.1's "/" route.
 *
 * Two things the prototype's static mock doesn't have to solve for that
 * a real upload flow does:
 *   - A file-selected state, distinct from the empty dropzone: the mock
 *     conflates "open the picker" and "submit" into one click because it
 *     has no real file to hold onto. Here, choosing or dropping a file
 *     moves the dropzone into a second state (filename, size, a real
 *     "Check this contract" button) so FR-7.2's pre-check and FR-7.3's
 *     disable-on-click both have something real to apply to.
 *   - The analyzing state below is a placeholder, not FR-7.4's staged
 *     progress (BUILD-PLAN step 34's job) — honest and non-committal
 *     about timing, never a fake percentage, but not the four-stage
 *     timer either.
 */
export default function UploadPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));

  const [activeTab, setActiveTab] = useState(/** @type {"file" | "paste"} */ ("file"));
  const [selectedFile, setSelectedFile] = useState(/** @type {File | null} */ (null));
  const [pasteText, setPasteText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState(
    /** @type {{ code: string, title: string, body: string, primary: string } | null} */ (
      null
    ),
  );
  const [submitting, setSubmitting] = useState(false);

  /** @param {File} file */
  function handleFileChosen(file) {
    const precheckError = checkFileBeforeUpload(file, { maxBytes: MAX_UPLOAD_BYTES });
    if (precheckError) {
      setUploadError(precheckError);
      setSelectedFile(null);
      return;
    }
    setUploadError(null);
    setSelectedFile(file);
  }

  /**
   * Tabs.jsx's onChange is typed `(id: string) => void` — it's a
   * general-purpose primitive that can't statically know this screen's
   * TABS only ever supplies "file"/"paste" ids, so the cast below is
   * narrowing a value this screen itself constrained, not asserting
   * something Tabs can't guarantee.
   * @param {string} tabId
   */
  function handleTabChange(tabId) {
    setActiveTab(/** @type {"file" | "paste"} */ (tabId));
    setUploadError(null);
  }

  /**
   * The error banner's primary button. "Choose another file" is the
   * only one of the five UPLOAD_ERRORS `primary` labels that names a
   * real follow-up action distinct from dismissal — opens the picker
   * directly rather than making the user find "Choose a file" again
   * underneath the banner. Every other label ("Paste more/less text",
   * "Got it") just clears the error: the field the user needs is
   * already visible right below it.
   */
  function handleErrorPrimaryClick() {
    if (uploadError?.primary === "Choose another file") {
      fileInputRef.current?.click();
    } else {
      setUploadError(null);
    }
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setUploadError(null);
    // FR-7.3: warns before navigation while a request is in flight. This
    // covers a real browser-level navigation (closing the tab,
    // reloading, typing a new URL) — there is no in-app navigation on
    // this screen yet for it to also guard (no nav chrome until step
    // 39), so that's the whole of what "in flight" needs guarding
    // against right now.
    window.addEventListener("beforeunload", warnBeforeUnload);

    try {
      /** @type {unknown} */
      let body;
      if (activeTab === "file") {
        const formData = new FormData();
        formData.append("file", /** @type {File} */ (selectedFile), selectedFile?.name);
        body = formData;
      } else {
        body = { text: pasteText };
      }

      const created = /** @type {{ document: { id: string } }} */ (
        await apiFetch("/api/v1/documents", { method: "POST", body })
      );
      await apiFetch(`/api/v1/documents/${created.document.id}/analyze`, {
        method: "POST",
      });
      navigate(`/documents/${created.document.id}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setUploadError(
        resolveServerUploadError(err, { intakeMode: activeTab, file: selectedFile }),
      );
    } finally {
      setSubmitting(false);
      window.removeEventListener("beforeunload", warnBeforeUnload);
    }
  }

  const canSubmitFile = selectedFile !== null;
  const canSubmitPaste = pasteText.trim() !== "";

  return (
    <div className="cc-upload-page">
      <SkipLink />
      <div className="cc-upload-page__hero">
        <h1 className="cc-upload-page__title">
          Hand over the contract.
          <br />
          <span className="cc-upload-page__title-accent">
            We'll point at the parts that could cost you.
          </span>
        </h1>
        <p className="cc-upload-page__intro">
          One document in, one plain-language report out — usually about 30 seconds. Every
          clause we flag is quoted word-for-word from your file and checked against it
          before you see it, so you can confirm nothing was invented. Delete the document
          permanently whenever you like.
        </p>
      </div>

      <main id="main" tabIndex={-1}>
        <div className="cc-upload-card">
          {submitting ? (
            <div className="cc-upload-analyzing" role="status" aria-live="polite">
              <p className="cc-upload-analyzing__title">Checking your contract…</p>
              <p className="cc-upload-analyzing__note">
                Usually about 30 seconds. We're reading the document, checking its
                clauses, and comparing it against the standard protections.
              </p>
            </div>
          ) : (
            <Tabs
              label="How to provide your contract"
              tabs={TABS}
              activeId={activeTab}
              onChange={handleTabChange}
            >
              {uploadError ? (
                <Banner
                  tone="danger"
                  title={uploadError.title}
                  className="cc-upload-card__error"
                >
                  {uploadError.body}
                  <div className="cc-upload-card__error-actions">
                    <Button onClick={handleErrorPrimaryClick}>
                      {uploadError.primary}
                    </Button>
                    {/* The prototype pairs "Paste the text instead" with EVERY
                        error unconditionally, including ones already on the
                        paste tab. Shown only for a file-tab error here — it's
                        not a useful escape hatch from a paste-tab error (you're
                        already there) or from a rate limit (pasting still
                        counts against the same limit). */}
                    {activeTab === "file" ? (
                      <Button variant="secondary" onClick={() => setActiveTab("paste")}>
                        Paste the text instead
                      </Button>
                    ) : null}
                  </div>
                  <div className="cc-upload-card__error-code">{uploadError.code}</div>
                </Banner>
              ) : null}

              {activeTab === "file" ? (
                <div
                  className={`cc-dropzone ${isDragging ? "cc-dropzone--dragging" : ""}`.trim()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setIsDragging(false);
                    const file = event.dataTransfer.files[0];
                    if (file) handleFileChosen(file);
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx"
                    // Not .cc-sr-only: that keeps an element focusable
                    // (for a live region, which needs Tab/AT to reach
                    // it) — this input is triggered only
                    // programmatically, by the visible "Choose a file"/
                    // "Choose a different file" button's onClick, which
                    // is the actual keyboard-operable control (Tab
                    // reaches the button; Enter/Space fires its click
                    // handler, which calls fileInputRef.current.click()
                    // and opens the native picker). Hidden with
                    // display:none, out of the tab order entirely, so it
                    // is never a second, unlabelled stop next to the
                    // button that does the same thing.
                    style={{ display: "none" }}
                    aria-hidden="true"
                    tabIndex={-1}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) handleFileChosen(file);
                      // Cleared so choosing the SAME file again (after
                      // "Choose a different file") still fires onChange.
                      event.target.value = "";
                    }}
                  />
                  {selectedFile ? (
                    <div className="cc-dropzone__selected">
                      <div className="cc-dropzone__eyebrow">Ready to check</div>
                      <div className="cc-dropzone__filename">{selectedFile.name}</div>
                      <div className="cc-dropzone__filesize">
                        {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                      </div>
                      <div className="cc-dropzone__actions">
                        <Button disabled={!canSubmitFile} onClick={handleSubmit}>
                          Check this contract
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          Choose a different file
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="cc-dropzone__eyebrow">PDF or DOCX</div>
                      <div className="cc-dropzone__title">Drop the contract here</div>
                      <div className="cc-dropzone__hint">
                        Up to about 8 pages — {MAX_DOCUMENT_WORDS.toLocaleString("en-US")}{" "}
                        words, 5 MB
                      </div>
                      <Button onClick={() => fileInputRef.current?.click()}>
                        Choose a file
                      </Button>
                    </>
                  )}
                </div>
              ) : (
                <div>
                  <TextField
                    label="Paste the contract text"
                    multiline
                    placeholder={
                      "INDEPENDENT CONTRACTOR AGREEMENT\n\nThis Agreement is made as of…"
                    }
                    value={pasteText}
                    onChange={(event) => setPasteText(event.target.value)}
                  />
                  <div className="cc-paste-panel__actions">
                    <Button disabled={!canSubmitPaste} onClick={handleSubmit}>
                      Check this contract
                    </Button>
                    <span className="cc-paste-panel__count">
                      {countWords(pasteText).toLocaleString("en-US")} words ·{" "}
                      {MIN_DOCUMENT_WORDS} minimum,{" "}
                      {MAX_DOCUMENT_WORDS.toLocaleString("en-US")} maximum
                    </span>
                  </div>
                </div>
              )}
            </Tabs>
          )}

          <div className="cc-upload-card__footer">
            <div className="cc-upload-card__footer-col">
              <div className="cc-upload-card__footer-title">
                What happens to your file
              </div>
              <div className="cc-upload-card__footer-body">
                It's read once to produce the report, then kept for up to 90 days so you
                can open it again — delete it any time and it's gone for good.
              </div>
            </div>
            <div className="cc-upload-card__footer-col">
              <div className="cc-upload-card__footer-title">What you get back</div>
              <div className="cc-upload-card__footer-body">
                An overall risk level, the clauses worth a second look with each one
                quoted, and the standard protections your contract is missing.
              </div>
            </div>
            <div className="cc-upload-card__footer-col">
              <div className="cc-upload-card__footer-title">What this isn't</div>
              <div className="cc-upload-card__footer-body">
                Legal advice. It's a first pass so you know which two or three paragraphs
                to ask about.
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
