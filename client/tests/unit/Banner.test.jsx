import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import Banner from "../../src/components/Banner.jsx";

describe("Banner (BUILD-PLAN step 30)", () => {
  it("renders a title and body", () => {
    render(
      <Banner title="Couldn't read that file">
        Try a version with real text, or paste the text directly.
      </Banner>,
    );
    expect(screen.getByText("Couldn't read that file")).toBeInTheDocument();
    expect(
      screen.getByText("Try a version with real text, or paste the text directly."),
    ).toBeInTheDocument();
  });

  it.each([
    ["danger", "alert"],
    ["warning", "alert"],
    ["info", "status"],
  ])("%s tone defaults to role=%s", (tone, role) => {
    render(<Banner tone={/** @type {"danger"|"warning"|"info"} */ (tone)}>x</Banner>);
    expect(screen.getByRole(role)).toBeInTheDocument();
  });

  it("an explicit role overrides the tone's default", () => {
    render(
      <Banner tone="info" role="alert">
        x
      </Banner>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("has no axe violations in any tone", async () => {
    for (const tone of /** @type {const} */ (["danger", "warning", "info"])) {
      const { container, unmount } = render(
        <Banner tone={tone} title="Heads up">
          Some detail.
        </Banner>,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
