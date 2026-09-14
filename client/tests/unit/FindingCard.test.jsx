import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import FindingCard from "../../src/pages/FindingCard.jsx";
import { I18nProvider } from "../../src/i18n/index.js";

const FINDING = {
  category: "LIABILITY",
  severity: "HIGH",
  clauseExcerpt: "Contractor shall indemnify Client against any and all claims.",
  explanation:
    "This is an uncapped indemnity — one dispute could cost you far more than the project pays.",
  suggestedChange:
    "Ask to cap your total liability at the fees paid under this agreement.",
};

/** @param {object} [overrides] */
function renderCard(overrides = {}) {
  return render(
    <I18nProvider>
      <FindingCard finding={{ ...FINDING, ...overrides }} />
    </I18nProvider>,
  );
}

describe("FindingCard (BUILD-PLAN step 36, PRD §7 / FR-7.5 / FR-7.8)", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("carries the category (as a heading), the severity as text, the quote, why, and the ask", () => {
    renderCard();

    expect(
      screen.getByRole("heading", { level: 3, name: "Liability" }),
    ).toBeInTheDocument();
    expect(screen.getByText("High severity")).toBeInTheDocument();
    expect(screen.getByText("Quoted from your contract")).toBeInTheDocument();
    expect(screen.getByText("Why it matters")).toBeInTheDocument();
    expect(screen.getByText("What to ask for")).toBeInTheDocument();

    const quote = document.querySelector("blockquote");
    expect(quote).toHaveTextContent(`“${FINDING.clauseExcerpt}”`);
    expect(screen.getByText(FINDING.suggestedChange)).toBeInTheDocument();
  });

  it("colours the quote rule by severity via the card's severity class", () => {
    const { container, rerender } = renderCard();
    expect(container.querySelector("article")).toHaveClass("cc-finding--high");

    rerender(
      <I18nProvider>
        <FindingCard finding={{ ...FINDING, severity: "LOW" }} />
      </I18nProvider>,
    );
    expect(container.querySelector("article")).toHaveClass("cc-finding--low");
    expect(screen.getByText("Low severity")).toBeInTheDocument();
  });

  it("the copy control copies the suggested change and shows and announces the prototype's confirmation", async () => {
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Copy this ask" }));

    await vi.waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(FINDING.suggestedChange),
    );
    const note = await screen.findByText(
      "Copied — paste it into your reply to the client.",
    );
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveAttribute("aria-live", "polite");
    expect(note).not.toHaveClass("cc-sr-only");
  });

  it("renders HTML in model output as literal text — never as markup (FR-7.8)", () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    const { container } = renderCard({
      clauseExcerpt: hostile,
      explanation: `${hostile} and an indemnity`,
      suggestedChange: hostile,
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(document.querySelector("blockquote")).toHaveTextContent(`“${hostile}”`);
    expect(screen.getAllByText(hostile, { exact: false }).length).toBeGreaterThan(0);
    expect(/** @type {any} */ (window).__pwned).toBeUndefined();
  });

  it("falls back to the Other label for a category it doesn't know", () => {
    renderCard({ category: "SOMETHING_NEW" });
    expect(screen.getByRole("heading", { level: 3, name: "Other" })).toBeInTheDocument();
  });

  it("turns a known term in the explanation into a glossary control, and only in the explanation", () => {
    renderCard();
    const term = screen.getByRole("button", { name: "indemnity" });
    expect(term).toHaveAttribute("aria-expanded", "false");

    // "liability" appears in the ask, but the ask is never glossed.
    const ask = screen.getByText(FINDING.suggestedChange);
    expect(within(ask).queryByRole("button")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = renderCard();
    expect(await axe(container)).toHaveNoViolations();
  });
});
