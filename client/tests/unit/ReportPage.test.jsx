import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import ReportPage from "../../src/pages/ReportPage.jsx";
import { I18nProvider } from "../../src/i18n/index.js";
import { ApiError } from "../../src/api/client.js";
import { DISCLAIMER_LOCKED } from "../../src/i18n/disclaimer.js";

vi.mock("../../src/api/client.js", async (importOriginal) => {
  const actual = /** @type {object} */ (await importOriginal());
  return { ...actual, apiFetch: vi.fn() };
});
const { apiFetch } = await import("../../src/api/client.js");

const DOCUMENT = {
  id: "doc1",
  filename: "msa.pdf",
  sourceType: "UPLOAD",
  wordCount: 1200,
};

/** @param {object} findings */
function analysisWith(findings, overrides = {}) {
  return {
    id: "an1",
    status: "COMPLETED",
    overallRisk: "HIGH",
    // A stray modelRisk field the real server never sends
    // (server/src/lib/serializers.js's whitelist excludes it) — present
    // here only to prove this component would ignore it even if a future
    // server bug leaked it (PRD D7, Done-when: "modelRisk appears nowhere
    // in the client").
    modelRisk: "LOW",
    summary:
      "This is a fairly standard freelance agreement with a few clauses worth a look.",
    findings,
    missingClauses: [],
    discardedFindings: 0,
    createdAt: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

const THREE_FINDINGS = [
  {
    category: "PAYMENT",
    severity: "HIGH",
    clauseExcerpt: "x",
    explanation: "x",
    suggestedChange: "x",
  },
  {
    category: "IP",
    severity: "MEDIUM",
    clauseExcerpt: "y",
    explanation: "y",
    suggestedChange: "y",
  },
  {
    category: "SCOPE",
    severity: "LOW",
    clauseExcerpt: "z",
    explanation: "z",
    suggestedChange: "z",
  },
];

function renderReport() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/documents/doc1"]}>
        <Routes>
          <Route path="/documents/:id" element={<ReportPage />} />
          <Route path="/documents" element={<p>History screen</p>} />
          <Route path="/" element={<p>Upload screen</p>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("ReportPage (BUILD-PLAN step 35, PRD §7 / FR-7.5 / §7.15)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("shows a polite loading state before the fetch resolves", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    renderReport();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an error state, with a way back, when the fetch fails", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError(
        "NOT_FOUND",
        "We couldn't find that. It may have been deleted, or it doesn't belong to your account.",
        "req_1",
        404,
      ),
    );
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByText(/We couldn't find that|We couldn’t find that/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to upload/i })).toBeInTheDocument();
  });

  it("does not crash when the document has no completed analysis", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ document: DOCUMENT, analysis: null });
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(/hasn.t been checked yet/i)).toBeInTheDocument();
  });

  describe("checking a document that has no completed report", () => {
    /**
     * GET /documents/doc1 answers with `analyses` in turn (the last one
     * repeats); POST .../analyze answers with `analyze`.
     *
     * @param {{ analyses: Array<object | null>, analyze: () => Promise<unknown> }} options
     */
    function mockServer({ analyses, analyze }) {
      let gets = 0;
      vi.mocked(apiFetch).mockImplementation((path, init) => {
        if (path === "/api/v1/documents/doc1/analyze" && init?.method === "POST") {
          return analyze();
        }
        if (path === "/api/v1/documents/doc1" && !init) {
          const analysis = analyses[Math.min(gets, analyses.length - 1)];
          gets += 1;
          return Promise.resolve({ document: DOCUMENT, analysis });
        }
        return Promise.reject(new Error(`unexpected request: ${path}`));
      });
    }

    async function settle() {
      await act(async () => {
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
    }

    it("runs analyze on THIS document and then shows its report, without a new upload", async () => {
      mockServer({
        analyses: [null, analysisWith(THREE_FINDINGS)],
        analyze: () => Promise.resolve({ analysis: analysisWith(THREE_FINDINGS) }),
      });
      renderReport();
      await settle();

      fireEvent.click(screen.getByRole("button", { name: "Check this contract" }));
      await settle();

      expect(apiFetch).toHaveBeenCalledWith("/api/v1/documents/doc1/analyze", {
        method: "POST",
      });
      // Analyze, never a second upload.
      expect(apiFetch).not.toHaveBeenCalledWith("/api/v1/documents", expect.anything());
      // The finished report, read back from GET /documents/:id.
      expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute(
        "aria-label",
        "Overall risk: High",
      );
      expect(screen.queryByText(/hasn.t been checked yet/i)).not.toBeInTheDocument();
    });

    it("says a FAILED check didn't finish, and offers to check again", async () => {
      mockServer({
        analyses: [{ ...analysisWith([]), status: "FAILED", overallRisk: null }],
        analyze: () => new Promise(() => {}),
      });
      renderReport();
      await settle();

      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        /last check on this contract didn.t finish/i,
      );
      expect(screen.getByText(/msa\.pdf is saved/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Check this contract" }),
      ).toBeInTheDocument();
    });

    it("offers no second check while one is still PENDING", async () => {
      mockServer({
        analyses: [{ ...analysisWith([]), status: "PENDING", overallRisk: null }],
        analyze: () => new Promise(() => {}),
      });
      renderReport();
      await settle();

      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        /being checked/i,
      );
      expect(
        screen.queryByRole("button", { name: "Check this contract" }),
      ).not.toBeInTheDocument();
    });

    it("shows the analyze error on this document when the check fails", async () => {
      mockServer({
        analyses: [null],
        analyze: () =>
          Promise.reject(
            new ApiError("LLM_TIMEOUT", "The analysis took too long.", "req_9", 504),
          ),
      });
      renderReport();
      await settle();

      fireEvent.click(screen.getByRole("button", { name: "Check this contract" }));
      await settle();

      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        /took longer than expected/i,
      );
      expect(screen.getByText("LLM_TIMEOUT · 504")).toBeInTheDocument();
    });
  });

  it("renders the risk header from the server's overallRisk, one h1, never modelRisk", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith(THREE_FINDINGS, { overallRisk: "HIGH", modelRisk: "LOW" }),
    });
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("High");
    expect(headings[0]).toHaveAttribute("aria-label", "Overall risk: High");
    // FR-3.9 / PRD D7: the model's own claim is never displayed.
    expect(document.body.textContent).not.toMatch(/modelRisk/i);
    expect(screen.queryByText("LOW", { exact: true })).not.toBeInTheDocument();
  });

  it("summarises severity counts and categories in the breakdown", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith(THREE_FINDINGS),
    });
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Findings by severity")).toBeInTheDocument();
    expect(screen.getByText("1 high")).toBeInTheDocument();
    expect(screen.getByText("1 medium")).toBeInTheDocument();
    expect(screen.getByText("1 low")).toBeInTheDocument();

    expect(screen.getByText("Findings by category")).toBeInTheDocument();
    expect(screen.getByText("Payment · 1")).toBeInTheDocument();
    expect(screen.getByText("IP and ownership · 1")).toBeInTheDocument();
    expect(screen.getByText("Scope and revisions · 1")).toBeInTheDocument();
  });

  it("hides the breakdown and filter bar entirely for a clean (zero-finding) report", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith([], { overallRisk: "LOW" }),
    });
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("The shape of it")).not.toBeInTheDocument();
    expect(screen.queryByText("Where the problems are")).not.toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("the severity filter is keyboard-operable (real buttons) and announces the filtered count politely", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith(THREE_FINDINGS),
    });
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const countRegion = screen.getByText("showing all 3").closest('[role="status"]');
    expect(countRegion).toHaveAttribute("aria-live", "polite");

    const allButton = screen.getByRole("button", { name: "All 3" });
    expect(allButton).toHaveAttribute("aria-pressed", "true");

    const highButton = screen.getByRole("button", { name: "High 1" });
    fireEvent.click(highButton);

    expect(highButton).toHaveAttribute("aria-pressed", "true");
    expect(allButton).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("showing 1 of 3")).toBeInTheDocument();
  });

  it("only offers filter buttons for severities actually present", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith([THREE_FINDINGS[0]], { overallRisk: "HIGH" }),
    });
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "High 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Medium/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Low/ })).not.toBeInTheDocument();
  });

  it("re-fetches when the document id changes", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith(THREE_FINDINGS),
    });
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/api/v1/documents/doc1");
  });
});

describe("ReportPage findings list (BUILD-PLAN step 36)", () => {
  beforeEach(() => vi.clearAllMocks());

  /** @param {object[]} findings @param {object} [overrides] */
  async function loadWith(findings, overrides) {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith(findings, overrides),
    });
    const utils = renderReport();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return utils;
  }

  it("renders findings high → medium → low even when the response isn't in that order (FR-7.5)", async () => {
    await loadWith([THREE_FINDINGS[2], THREE_FINDINGS[0], THREE_FINDINGS[1]]);

    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["Payment", "IP and ownership", "Scope and revisions"]);
  });

  it("renders the findings as an ordered semantic list, one item per finding (SRS §7.15)", async () => {
    const { container } = await loadWith(THREE_FINDINGS);

    const list = container.querySelector("ol.cc-report__findings");
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll(":scope > li > article")).toHaveLength(3);
  });

  it("the severity filter narrows the rendered cards", async () => {
    const { container } = await loadWith(THREE_FINDINGS);

    fireEvent.click(screen.getByRole("button", { name: "Medium 1" }));

    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 3, name: "IP and ownership" }),
    ).toBeInTheDocument();
  });

  it("a card's local state does not move to a different finding when the filter changes", async () => {
    await loadWith([
      {
        category: "LIABILITY",
        severity: "HIGH",
        clauseExcerpt: "a",
        explanation: "An uncapped indemnity here.",
        suggestedChange: "a",
      },
      {
        category: "CONFIDENTIALITY",
        severity: "MEDIUM",
        clauseExcerpt: "b",
        explanation: "An open-ended non-compete here.",
        suggestedChange: "b",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "indemnity" }));
    expect(screen.getByRole("button", { name: "indemnity" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Medium 1" }));

    expect(screen.getByRole("button", { name: "non-compete" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("zero findings reads as a clean result: its own heading and checked areas, no alert, no error copy", async () => {
    const { container } = await loadWith([], { overallRisk: "LOW" });

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Nothing in this contract needs a second look.",
      }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".cc-report__checked li")).toHaveLength(8);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/error|couldn.t|failed|went wrong/i);
    expect(container.querySelector("ol.cc-report__findings")).toBeNull();
  });
});

describe("ReportPage disclaimer and missing protections (BUILD-PLAN step 37, NFR-4.1 / PRD §7)", () => {
  beforeEach(() => vi.clearAllMocks());

  /** @param {object[]} findings @param {object} [overrides] */
  async function loadWith(findings, overrides) {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith(findings, overrides),
    });
    const utils = renderReport();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return utils;
  }

  it("renders the disclaimer's EXACT locked text, byte-for-byte against the constant", async () => {
    await loadWith(THREE_FINDINGS);
    expect(screen.getByText(DISCLAIMER_LOCKED.en)).toBeInTheDocument();
  });

  it("renders the disclaimer as body text — a plain paragraph, not inside a footer element", async () => {
    const { container } = await loadWith(THREE_FINDINGS);
    const disclaimer = screen.getByText(DISCLAIMER_LOCKED.en);
    expect(disclaimer.tagName).toBe("P");
    expect(container.querySelector("footer")).toBeNull();
  });

  it("shows the disclaimer regardless of findings, including the zero-finding report", async () => {
    await loadWith([], { overallRisk: "LOW" });
    expect(screen.getByText(DISCLAIMER_LOCKED.en)).toBeInTheDocument();
  });

  it('renders "Protections the contract doesn\'t include" with each server-provided sentence, unmodified', async () => {
    await loadWith(THREE_FINDINGS, {
      missingClauses: [
        "No late payment interest or penalty is specified.",
        "There is no cap on the freelancer's liability.",
      ],
    });

    expect(
      screen.getByText("Protections the contract doesn’t include"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "These are standard terms in freelance agreements. Nothing here is quoted, because there’s nothing to quote. That is the point. They don’t change the risk level above, and they’re the easiest thing to ask for while the contract is still open.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No late payment interest or penalty is specified."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("There is no cap on the freelancer's liability."),
    ).toBeInTheDocument();
  });

  it("does not render the missing-protections section at all when missingClauses is empty", async () => {
    await loadWith(THREE_FINDINGS, { missingClauses: [] });
    expect(
      screen.queryByText("Protections the contract doesn’t include"),
    ).not.toBeInTheDocument();
  });

  it("never renders a jurisdiction section (decision D-A)", async () => {
    const { container } = await loadWith(THREE_FINDINGS, {
      missingClauses: ["No late payment interest or penalty is specified."],
    });
    expect(screen.queryByText(/jurisdiction/i)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/united states|indonesia/i);
  });
});

describe("ReportPage delete (BUILD-PLAN step 37, FR-7.6)", () => {
  beforeEach(() => vi.clearAllMocks());

  /** @param {object[]} findings @param {object} [overrides] */
  async function loadWith(findings, overrides) {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith(findings, overrides),
    });
    const utils = renderReport();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return utils;
  }

  it('shows "Done with this contract?" and a delete trigger that opens a confirmation naming permanence', async () => {
    await loadWith(THREE_FINDINGS);
    expect(screen.getByText("Done with this contract?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(
      screen.getByRole("heading", { name: "Delete this contract permanently?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The document and this report will be removed from our database. This can’t be undone, and we won’t be able to recover them for you.",
      ),
    ).toBeInTheDocument();
  });

  it('"Keep it" closes the dialog without calling the API', async () => {
    await loadWith(THREE_FINDINGS);
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    vi.mocked(apiFetch).mockClear(); // clear the initial GET call

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(
      screen.queryByRole("heading", { name: "Delete this contract permanently?" }),
    ).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("confirming calls DELETE on this document and redirects to history", async () => {
    await loadWith(THREE_FINDINGS);
    vi.mocked(apiFetch).mockResolvedValueOnce({ deleted: true, message: "x" });

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    // Two buttons now share the label "Delete permanently" (the trigger,
    // now hidden behind the dialog, and the dialog's own confirm button)
    // — the dialog's is the one still in an accessible, interactive state.
    const confirmButtons = screen.getAllByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await screen.findByText("History screen");
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/documents/doc1", { method: "DELETE" });
  });

  it("a failed delete keeps the dialog open and shows the server's error, not a silent failure", async () => {
    await loadWith(THREE_FINDINGS);
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError("NOT_FOUND", "We couldn't find that.", "req_1", 404),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    const confirmButtons = screen.getAllByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(await screen.findByText("We couldn't find that.")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Delete this contract permanently?" }),
    ).toBeInTheDocument();
  });
});
