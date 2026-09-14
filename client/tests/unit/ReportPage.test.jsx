import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import ReportPage from "../../src/pages/ReportPage.jsx";
import { I18nProvider } from "../../src/i18n/index.js";
import { ApiError } from "../../src/api/client.js";

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

  it('summarises severity counts under "The shape of it" and categories under "Where the problems are"', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      document: DOCUMENT,
      analysis: analysisWith(THREE_FINDINGS),
    });
    renderReport();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("The shape of it")).toBeInTheDocument();
    expect(screen.getByText("1 high")).toBeInTheDocument();
    expect(screen.getByText("1 medium")).toBeInTheDocument();
    expect(screen.getByText("1 low")).toBeInTheDocument();

    expect(screen.getByText("Where the problems are")).toBeInTheDocument();
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
