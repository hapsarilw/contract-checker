import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import Button from "../../src/components/Button.jsx";

describe("Button (BUILD-PLAN step 30)", () => {
  it("renders a real <button>, not a styled <div>, so it is keyboard-operable for free", () => {
    render(<Button>Choose a file</Button>);
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
  });

  it("defaults to type=button, so it never submits a form by accident", () => {
    render(<Button>Choose a file</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("type=submit is available when that IS the intent", () => {
    render(<Button type="submit">Sign in</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });

  it.each(/** @type {const} */ (["primary", "secondary", "destructive"]))(
    "applies the %s variant's class",
    (variant) => {
      render(<Button variant={variant}>Go</Button>);
      expect(screen.getByRole("button")).toHaveClass(`cc-button--${variant}`);
    },
  );

  it("fires onClick from a real click, and from the keyboard (Enter)", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);

    const button = screen.getByRole("button");
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");

    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("has no axe violations in any variant", async () => {
    for (const variant of /** @type {const} */ ([
      "primary",
      "secondary",
      "destructive",
    ])) {
      const { container, unmount } = render(<Button variant={variant}>Go</Button>);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
