import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import HistoryPage from "../../src/pages/HistoryPage.jsx";
import { I18nProvider } from "../../src/i18n/index.js";
import { ApiError } from "../../src/api/client.js";

vi.mock("../../src/api/client.js", async (importOriginal) => {
  const actual = /** @type {object} */ (await importOriginal());
  return { ...actual, apiFetch: vi.fn() };
});
const { apiFetch } = await import("../../src/api/client.js");

/** @param {object[]} documents @param {{ nextCursor?: string | null, hasMore?: boolean }} [page] */
function listPage(documents, page = {}) {
  return {
    documents,
    page: { nextCursor: page.nextCursor ?? null, hasMore: page.hasMore ?? false },
  };
}

const ROW_A = {
  id: "doc-a",
  filename: "msa.pdf",
  wordCount: 1200,
  overallRisk: "HIGH",
  findingCount: 3,
  createdAt: "2026-01-05T00:00:00.000Z",
};
const ROW_B = {
  id: "doc-b",
  filename: "Pasted text",
  wordCount: 400,
  overallRisk: "LOW",
  findingCount: 0,
  createdAt: "2026-01-02T00:00:00.000Z",
};

function renderHistory() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/documents"]}>
        <Routes>
          <Route path="/documents" element={<HistoryPage />} />
          <Route path="/documents/:id" element={<p>Report screen</p>} />
          <Route path="/" element={<p>Upload screen</p>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("HistoryPage (BUILD-PLAN step 38, FR-4.1 / FR-7.14)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("shows a polite loading state before the fetch resolves", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    renderHistory();
    expect(
      screen.getByRole("heading", { level: 1, name: "History" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an error banner when the fetch fails", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError("UNAUTHENTICATED", "Session problem.", "req_1", 401),
    );
    renderHistory();
    await flush();
    expect(screen.getByText("Session problem.")).toBeInTheDocument();
  });

  it("matches the prototype's empty state: title, body, and a CTA to the upload screen", async () => {
    vi.mocked(apiFetch).mockResolvedValue(listPage([]));
    renderHistory();
    await flush();

    expect(screen.getByText("No contracts checked yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/it.ll be listed here with its risk level/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Every contract you check is listed here."),
    ).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: "Check your first contract" });
    expect(cta).toHaveAttribute("href", "/");
  });

  it("lists each row: filename, word count, risk, and finding count", async () => {
    vi.mocked(apiFetch).mockResolvedValue(listPage([ROW_A, ROW_B]));
    renderHistory();
    await flush();

    expect(screen.getByText("msa.pdf")).toBeInTheDocument();
    expect(screen.getByText("1,200 words")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("3 findings")).toBeInTheDocument();

    expect(screen.getByText("Pasted text")).toBeInTheDocument();
    expect(screen.getByText("400 words")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("No findings")).toBeInTheDocument();

    expect(
      screen.getByText("Open a report again, or delete a contract for good."),
    ).toBeInTheDocument();
  });

  it("a document with no completed analysis shows 'Not yet analyzed' rather than a false 'No findings'", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      listPage([{ ...ROW_A, overallRisk: null, findingCount: 0 }]),
    );
    renderHistory();
    await flush();

    expect(screen.getByText("Not yet analyzed")).toBeInTheDocument();
    expect(screen.queryByText("No findings")).not.toBeInTheDocument();
  });

  it("each row links to its report", async () => {
    vi.mocked(apiFetch).mockResolvedValue(listPage([ROW_A]));
    renderHistory();
    await flush();

    expect(screen.getByRole("link", { name: /msa\.pdf/ })).toHaveAttribute(
      "href",
      "/documents/doc-a",
    );
  });

  it("formats the UTC timestamp via Intl in the viewer's own locale, never a server-sent string verbatim", async () => {
    vi.mocked(apiFetch).mockResolvedValue(listPage([ROW_A]));
    renderHistory();
    await flush();

    // The exact rendered text depends on the test runner's ICU data, so
    // this asserts the CONTRACT (Intl formatting of the real Date, not
    // the raw ISO string passed through) rather than one locale's output.
    const expected = new Date(ROW_A.createdAt).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(ROW_A.createdAt)).not.toBeInTheDocument();
  });

  it('shows "Load more" only when the server says there is more, and appends without duplicating', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      listPage([ROW_A], { nextCursor: "cur1", hasMore: true }),
    );
    renderHistory();
    await flush();

    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();

    vi.mocked(apiFetch).mockResolvedValueOnce(
      listPage([ROW_B], { nextCursor: null, hasMore: false }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await flush();

    expect(apiFetch).toHaveBeenLastCalledWith("/api/v1/documents?cursor=cur1");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("msa.pdf")).toBeInTheDocument();
    expect(screen.getByText("Pasted text")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("does not show 'Load more' when the first page is already everything", async () => {
    vi.mocked(apiFetch).mockResolvedValue(listPage([ROW_A], { hasMore: false }));
    renderHistory();
    await flush();

    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("a failed 'Load more' shows an error and keeps the already-loaded rows", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      listPage([ROW_A], { nextCursor: "cur1", hasMore: true }),
    );
    renderHistory();
    await flush();

    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError("NETWORK_ERROR", "Couldn't reach the server.", undefined, 0),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await flush();

    expect(screen.getByText("Couldn't reach the server.")).toBeInTheDocument();
    expect(screen.getByText("msa.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("deleting a row removes it from the list without a re-fetch, and without duplicating the rest", async () => {
    vi.mocked(apiFetch).mockResolvedValue(listPage([ROW_A, ROW_B]));
    renderHistory();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Delete msa.pdf" }));
    expect(
      screen.getByRole("heading", { name: "Delete this contract permanently?" }),
    ).toBeInTheDocument();

    vi.mocked(apiFetch).mockResolvedValueOnce({ deleted: true, message: "x" });
    const confirmButtons = screen.getAllByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await flush();

    expect(apiFetch).toHaveBeenLastCalledWith("/api/v1/documents/doc-a", {
      method: "DELETE",
    });
    expect(screen.queryByText("msa.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("Pasted text")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("a failed row delete keeps the dialog open with the server's error", async () => {
    vi.mocked(apiFetch).mockResolvedValue(listPage([ROW_A]));
    renderHistory();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Delete msa.pdf" }));
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError("NOT_FOUND", "We couldn't find that.", "req_1", 404),
    );
    const confirmButtons = screen.getAllByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await flush();

    expect(await screen.findByText("We couldn't find that.")).toBeInTheDocument();
    expect(screen.getByText("msa.pdf")).toBeInTheDocument();
  });

  it("'Keep it' closes the delete dialog without calling the API again", async () => {
    vi.mocked(apiFetch).mockResolvedValue(listPage([ROW_A]));
    renderHistory();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Delete msa.pdf" }));
    vi.mocked(apiFetch).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(
      screen.queryByRole("heading", { name: "Delete this contract permanently?" }),
    ).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByText("msa.pdf")).toBeInTheDocument();
  });
});
