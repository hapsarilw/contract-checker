import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import SeverityBadge from "../../src/components/SeverityBadge.jsx";

describe("SeverityBadge (BUILD-PLAN step 30, WCAG 1.4.1)", () => {
  it("renders the text label, findable as text — the label is the accessible name, not the shape", () => {
    render(<SeverityBadge severity="high" label="High" />);
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it.each([
    ["high", "●●●"],
    ["medium", "●●○"],
    ["low", "●○○"],
  ])(
    "%s renders a distinct dot-count shape (%s), not only a colour difference",
    (severity, mark) => {
      const { container } = render(
        <SeverityBadge
          severity={/** @type {"high"|"medium"|"low"} */ (severity)}
          label="x"
        />,
      );
      expect(container.querySelector(".cc-severity-badge__mark")).toHaveTextContent(mark);
    },
  );

  it("hides the shape glyph from assistive technology — a screen reader reads the label, never the glyph", () => {
    render(<SeverityBadge severity="high" label="High" />);
    // aria-hidden="true" removes an element (and its text) from the
    // accessibility tree entirely — this is the direct, spec-level test
    // that a screen reader never reaches the glyph. The visible label
    // ("High") is an ordinary, un-hidden text node right next to it, so
    // it reads normally; the earlier test already confirms it's present.
    expect(document.querySelector(".cc-severity-badge__mark")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("each severity applies its own modifier class — SeverityBadge.css pairs each with tokens.css's tint/colour, checked directly in severityBadgeContrast.test.js", () => {
    for (const severity of /** @type {const} */ (["high", "medium", "low"])) {
      const { container, unmount } = render(
        <SeverityBadge severity={severity} label="x" />,
      );
      expect(container.firstElementChild).toHaveClass(`cc-severity-badge--${severity}`);
      unmount();
    }
  });

  it("has no axe violations for any of the three severities", async () => {
    for (const severity of /** @type {const} */ (["high", "medium", "low"])) {
      const { container, unmount } = render(
        <SeverityBadge severity={severity} label={severity} />,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
