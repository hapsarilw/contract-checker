import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import Card from "../../src/components/Card.jsx";

describe("Card (BUILD-PLAN step 30)", () => {
  it("renders its children", () => {
    render(
      <Card>
        <p>Report body</p>
      </Card>,
    );
    expect(screen.getByText("Report body")).toBeInTheDocument();
  });

  it("applies the accent class only when asked", () => {
    const { container: plain } = render(<Card>plain</Card>);
    expect(plain.firstElementChild).not.toHaveClass("cc-card--accent");

    const { container: accented } = render(<Card accent>accented</Card>);
    expect(accented.firstElementChild).toHaveClass("cc-card--accent");
  });

  it("forwards arbitrary props (e.g. a semantic role) to the underlying element", () => {
    render(
      <Card role="region" aria-label="Report summary">
        content
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Report summary" })).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <Card accent>
        <h2>Overall risk</h2>
        <p>High</p>
      </Card>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
