import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";
import { useI18n } from "../i18n/useI18n.js";
import { SEVERITY_MARKS } from "../components/SeverityBadge.jsx";
import Banner from "../components/Banner.jsx";
import Button from "../components/Button.jsx";
import DeleteDocumentDialog from "../components/DeleteDocumentDialog.jsx";
import "./HistoryPage.css";

/** FR-7.14: the server sends UTC ISO-8601; this is the ONLY place it's formatted, in the viewer's own locale and timezone via Intl (through Date's locale methods, which are Intl under the hood). */
function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * BUILD-PLAN step 38 — `/documents`, matched to the prototype's "4.
 * HISTORY" and "history-empty" screens (docs/design/ClauseCheck.html) —
 * kept as two distinct visual states here too, per this step's own
 * instructions ("the prototype treats them as two distinct screens,
 * which is the right instinct").
 *
 * FR-4.1's cursor pagination (server/src/lib/pagination.js, step 19):
 * `nextCursor` is opaque and passed back to the server verbatim as
 * `?cursor=`, never decoded or inspected here — decodeCursor's own
 * comment is explicit that its shape is not a client contract.
 * "Load more" APPENDS to the existing list rather than replacing it,
 * which is what makes deleting a row further down the list, then
 * loading another page, produce no duplicates: each page is fetched
 * once and its rows kept exactly once, in the client array, independent
 * of what a re-fetch of page 1 would return.
 */
export default function HistoryPage() {
  const { t } = useI18n();
  const [state, setState] = useState(
    /** @type {{ status: "loading" | "loaded" | "error", documents: object[], nextCursor: string | null, hasMore: boolean, error: unknown }} */ ({
      status: "loading",
      documents: [],
      nextCursor: null,
      hasMore: false,
      error: null,
    }),
  );
  const [loadMoreState, setLoadMoreState] = useState(
    /** @type {{ loading: boolean, error: string | null }} */ ({
      loading: false,
      error: null,
    }),
  );
  const [deleteState, setDeleteState] = useState(
    /** @type {{ target: { id: string, name: string } | null, deleting: boolean, error: string | null }} */ ({
      target: null,
      deleting: false,
      error: null,
    }),
  );

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/v1/documents").then(
      (body) => {
        if (cancelled) return;
        const typed =
          /** @type {{ documents: object[], page: { nextCursor: string | null, hasMore: boolean } }} */ (
            body
          );
        setState({
          status: "loaded",
          documents: typed.documents,
          nextCursor: typed.page.nextCursor,
          hasMore: typed.page.hasMore,
          error: null,
        });
      },
      (err) => {
        if (cancelled) return;
        setState((current) => ({ ...current, status: "error", error: err }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLoadMore() {
    if (loadMoreState.loading || !state.nextCursor) return;
    setLoadMoreState({ loading: true, error: null });
    try {
      const body = await apiFetch(
        `/api/v1/documents?cursor=${encodeURIComponent(state.nextCursor)}`,
      );
      const typed =
        /** @type {{ documents: object[], page: { nextCursor: string | null, hasMore: boolean } }} */ (
          body
        );
      setState((current) => ({
        ...current,
        documents: [...current.documents, ...typed.documents],
        nextCursor: typed.page.nextCursor,
        hasMore: typed.page.hasMore,
      }));
      setLoadMoreState({ loading: false, error: null });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setLoadMoreState({ loading: false, error: err.message });
    }
  }

  function closeDeleteDialog() {
    setDeleteState({ target: null, deleting: false, error: null });
  }

  async function handleConfirmDelete() {
    const target = deleteState.target;
    if (!target) return;
    setDeleteState((current) => ({ ...current, deleting: true, error: null }));
    try {
      await apiFetch(`/api/v1/documents/${target.id}`, { method: "DELETE" });
      // Removed from the already-fetched list, not a re-fetch of page
      // one: a re-fetch after a delete can shift EVERY row after it into
      // the position the removed row held, which the keyset cursors held
      // in state no longer point at consistently. Filtering the local
      // array by id has no such problem — it's exact, and free.
      setState((current) => ({
        ...current,
        documents: current.documents.filter((document) => document.id !== target.id),
      }));
      setDeleteState({ target: null, deleting: false, error: null });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setDeleteState({ target, deleting: false, error: err.message });
    }
  }

  const isEmpty = state.status === "loaded" && state.documents.length === 0;

  return (
    <div className="cc-history">
      <main id="main" tabIndex={-1}>
        <h1 className="cc-history__title">{t.navHistory}</h1>
        <p className="cc-history__blurb">
          {isEmpty ? t.historyBlurbEmpty : t.historyBlurbFull}
        </p>

        {state.status === "loading" ? (
          /* A skeleton in the shape of the list that is coming, not a
             line of text where the list will be. The announcement still
             happens for assistive technology (the visually-hidden status
             below); the placeholder rows are aria-hidden because a screen
             reader has nothing to gain from four empty rows. */
          <>
            <p role="status" aria-live="polite" className="cc-sr-only">
              Loading your contracts
            </p>
            <ul
              className="cc-history__list cc-history__list--skeleton"
              aria-hidden="true"
            >
              {[0, 1, 2, 3].map((row) => (
                <li className="cc-history__row" key={row}>
                  <div
                    className="cc-history__skeleton-row"
                    /* A custom property, which React passes through fine
                       but React's CSSProperties type does not describe. */
                    style={
                      /** @type {import("react").CSSProperties} */ ({
                        "--cc-rise-delay": row * 70 + "ms",
                      })
                    }
                  >
                    <span className="cc-history__skeleton-bar cc-history__skeleton-bar--name" />
                    <span className="cc-history__skeleton-bar cc-history__skeleton-bar--meta" />
                    <span className="cc-history__skeleton-bar cc-history__skeleton-bar--meta" />
                    <span className="cc-history__skeleton-bar cc-history__skeleton-bar--risk" />
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {state.status === "error" ? (
          <Banner tone="danger">
            {state.error instanceof ApiError
              ? state.error.message
              : "Something went wrong loading your contracts. Try again in a moment."}
          </Banner>
        ) : null}

        {isEmpty ? (
          <div className="cc-history__empty">
            <h2 className="cc-history__empty-title">{t.historyEmptyTitle}</h2>
            <p className="cc-history__empty-body">{t.historyEmptyBody}</p>
            {/* A real navigation, not a click handler that calls
                navigate() — Button.jsx has no polymorphic "as" prop, and
                this is a Link in intent (SRS §7.15's keyboard/landmark
                rules apply equally to it), so it wears Button's own
                classes directly rather than gaining one for a single
                call site. */}
            <Link to="/" className="cc-button cc-button--primary">
              {t.historyEmptyCta}
            </Link>
          </div>
        ) : null}

        {state.status === "loaded" && state.documents.length > 0 ? (
          <>
            <ul className="cc-history__list">
              {state.documents.map((document) => (
                <li className="cc-history__row" key={document.id}>
                  <Link to={`/documents/${document.id}`} className="cc-history__row-link">
                    <span className="cc-history__row-name">{document.filename}</span>
                    <span className="cc-history__row-date">
                      {formatDate(document.createdAt)}
                    </span>
                    <span className="cc-history__row-words">
                      {document.wordCount.toLocaleString("en-US")} words
                    </span>
                    {document.overallRisk ? (
                      <span
                        className={`cc-history__row-risk cc-history__row-risk--${document.overallRisk.toLowerCase()}`}
                      >
                        <span className="cc-history__row-risk-mark" aria-hidden="true">
                          {SEVERITY_MARKS[document.overallRisk.toLowerCase()]}
                        </span>
                        <span className="cc-history__row-risk-label">
                          {t.severity[document.overallRisk]}
                        </span>
                      </span>
                    ) : (
                      <span className="cc-history__row-risk cc-history__row-risk--none">
                        {t.historyNotAnalyzed}
                      </span>
                    )}
                    <span className="cc-history__row-findings">
                      {document.overallRisk === null
                        ? t.historyNotChecked
                        : document.findingCount === 0
                          ? t.historyNoFindings
                          : document.findingCount +
                            " " +
                            t.findingWord[document.findingCount === 1 ? 0 : 1]}
                    </span>
                  </Link>
                  <button
                    type="button"
                    className="cc-history__row-delete"
                    aria-label={`${t.deleteRow} ${document.filename}`}
                    onClick={() =>
                      setDeleteState({
                        target: { id: document.id, name: document.filename },
                        deleting: false,
                        error: null,
                      })
                    }
                  >
                    {t.deleteRow}
                  </button>
                </li>
              ))}
            </ul>

            {state.hasMore ? (
              <div className="cc-history__load-more">
                <Button
                  variant="secondary"
                  onClick={handleLoadMore}
                  disabled={loadMoreState.loading}
                >
                  {loadMoreState.loading ? t.loadingMore : t.loadMore}
                </Button>
                {loadMoreState.error ? (
                  <Banner tone="danger" className="cc-history__load-more-error">
                    {loadMoreState.error}
                  </Banner>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </main>

      <DeleteDocumentDialog
        open={deleteState.target !== null}
        deleting={deleteState.deleting}
        error={deleteState.error}
        onConfirm={handleConfirmDelete}
        onClose={closeDeleteDialog}
      />
    </div>
  );
}
