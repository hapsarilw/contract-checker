import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import GlossaryTerm from "../../src/components/GlossaryTerm.jsx";

const MEANING =
  "A promise to cover the other side’s losses if a claim is made against them.";

function renderTerm() {
  return render(
    <div>
      <p>
        This is an uncapped <GlossaryTerm term="indemnity" meaning={MEANING} /> — one
        dispute could cost you a lot.
      </p>
      <button type="button">Somewhere else</button>
    </div>,
  );
}

describe("GlossaryTerm (BUILD-PLAN step 36, decision D-C)", () => {
  it("is a real button, collapsed by default, with the definition hidden", () => {
    renderTerm();
    const button = screen.getByRole("button", { name: "indemnity" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(MEANING)).not.toBeVisible();
  });

  it("opens on activation, and aria-controls points at the definition", () => {
    renderTerm();
    const button = screen.getByRole("button", { name: "indemnity" });

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    const definition = screen.getByText(MEANING);
    expect(definition).toBeVisible();
    expect(
      document.getElementById(button.getAttribute("aria-controls") ?? ""),
    ).toContainElement(definition);
  });

  it("closes on Escape and leaves focus on the term", () => {
    renderTerm();
    const button = screen.getByRole("button", { name: "indemnity" });
    button.focus();
    fireEvent.click(button);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(MEANING)).not.toBeVisible();
    expect(document.activeElement).toBe(button);
  });

  it("closes on a second activation and on a click outside", () => {
    renderTerm();
    const button = screen.getByRole("button", { name: "indemnity" });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Somewhere else" }));
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("a click inside the open definition does not close it", () => {
    renderTerm();
    const button = screen.getByRole("button", { name: "indemnity" });
    fireEvent.click(button);

    fireEvent.mouseDown(screen.getByText(MEANING));

    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("has no axe violations, closed or open", async () => {
    const { container } = renderTerm();
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button", { name: "indemnity" }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
