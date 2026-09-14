import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import AnalyzingPanel from "../../src/pages/AnalyzingPanel.jsx";
import { ApiError } from "../../src/api/client.js";

vi.mock("../../src/api/client.js", async (importOriginal) => {
  // ApiError is real (this file constructs real instances of it below);
  // only apiFetch is a mock — importOriginal's return type isn't known
  // to be spreadable on its own, so it's asserted to an object here.
  const actual = /** @type {object} */ (await importOriginal());
  return { ...actual, apiFetch: vi.fn() };
});
const { apiFetch } = await import("../../src/api/client.js");

const META = { filename: "contract.pdf", wordCount: 980 };

describe("AnalyzingPanel (BUILD-PLAN step 34, FR-7.4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders one h1, the meta line, and the first stage as current with its note", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {})); // never resolves — hold on the running state
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("contract.pdf · 980 words")).toBeInTheDocument();
    expect(screen.getByText("Reading the document")).toBeInTheDocument();
    expect(
      screen.getByText("Pulling the text out and checking it looks like a contract."),
    ).toBeInTheDocument();
  });

  it("NEVER renders a percentage, a progress-bar value, or any numeric count of anything but words (FR-7.4's honesty constraint)", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/\d+\s*(of|\/)\s*\d+/); // "2 of 4", "2/4"
    // Two legitimate numbers appear on this screen: the meta line's
    // word count, and FR-7.4's own explicitly-allowed "usually about 30
    // seconds" overall expectation — stripped out here so what's
    // checked for is a THIRD number this screen has no business
    // showing (a stage counter, a fake elapsed-time readout, a percent
    // rendered as a bare number, ...).
    const withoutLegitimateNumbers = text
      .replace("contract.pdf · 980 words", "")
      .replace("30 seconds", "");
    expect(withoutLegitimateNumbers).not.toMatch(/\d/);
  });

  it("advances to the next stage after STAGE_DURATION_MS, marking the previous one done", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );

    act(() => vi.advanceTimersByTime(30_000 / 4));

    expect(screen.getByText("Examining the clauses")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Payment, ownership, scope, termination, liability, confidentiality, disputes.",
      ),
    ).toBeInTheDocument();
    // Stage 1's note is only shown while it's current.
    expect(
      screen.queryByText("Pulling the text out and checking it looks like a contract."),
    ).not.toBeInTheDocument();
  });

  it("clamps at the last stage rather than advancing past it or crashing", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );

    act(() => vi.advanceTimersByTime((30_000 / 4) * 20)); // far past all four stages

    expect(screen.getByText("Checking what's missing")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Comparing against the protections a freelance contract normally has.",
      ),
    ).toBeInTheDocument();
  });

  it("the stage region is role=status, aria-live=polite, and this component never calls .focus()", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");

    act(() => vi.advanceTimersByTime(30_000 / 4));
    expect(focusSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
  });

  it("marks the current stage's row with aria-current=step", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );

    const current = document.querySelector('[aria-current="step"]');
    expect(current).toHaveTextContent("Reading the document");
  });

  it("calls onComplete with the analysis when the real request succeeds", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ analysis: { id: "an1" } });
    const onComplete = vi.fn();
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={onComplete}
        onBackToUpload={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onComplete).toHaveBeenCalledWith({ id: "an1" });
  });

  it.each([
    ["LLM_INVALID_OUTPUT", "The check didn’t finish."],
    ["LLM_TIMEOUT", "This took longer than expected, so we stopped."],
    ["ALL_FINDINGS_DISCARDED", "We couldn’t verify any of what came back."],
    ["ANALYSIS_IN_PROGRESS", "This contract is already being checked."],
  ])("renders the %s error card instead of the stages", async (code, title) => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError(code, "x", "req_1", 500));
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Reading the document")).not.toBeInTheDocument();
  });

  it("'Try again' resets to stage 1 and re-issues the analyze call", async () => {
    // fireEvent, not userEvent — userEvent's internal delay handling
    // does not play well with fake timers here (confirmed directly: it
    // hangs to the test timeout), the same interaction step 30's
    // CopyButton test ran into.
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError("LLM_TIMEOUT", "x", "req_1", 504),
    );
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByText("This took longer than expected, so we stopped."),
    ).toBeInTheDocument();

    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {})); // hang on the retry
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("Reading the document")).toBeInTheDocument();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
  });

  it("'Back to upload' calls onBackToUpload", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError("LLM_TIMEOUT", "x", "req_1", 504));
    const onBackToUpload = vi.fn();
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={META}
        onComplete={() => {}}
        onBackToUpload={onBackToUpload}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to upload" }));

    expect(onBackToUpload).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'Pasted text' when there is no filename (the paste path)", () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    render(
      <AnalyzingPanel
        documentId="doc1"
        meta={{ filename: null, wordCount: 250 }}
        onComplete={() => {}}
        onBackToUpload={() => {}}
      />,
    );
    expect(screen.getByText("Pasted text · 250 words")).toBeInTheDocument();
  });
});
