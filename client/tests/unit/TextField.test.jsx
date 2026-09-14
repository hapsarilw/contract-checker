import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import TextField from "../../src/components/TextField.jsx";

describe("TextField (BUILD-PLAN step 30, SRS §7.15 Forms row)", () => {
  it("associates the label programmatically — findable by its accessible name", () => {
    render(<TextField label="Email address" />);
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
  });

  it("has no aria-invalid and no error slot when there is no error", () => {
    render(<TextField label="Email address" />);
    const input = screen.getByLabelText("Email address");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("sets aria-invalid and links the error text via aria-describedby", () => {
    render(<TextField label="Email address" error="Enter a valid email address" />);
    const input = screen.getByLabelText("Email address");
    const error = screen.getByText("Enter a valid email address");

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
  });

  it("links a hint the same way, and links BOTH when hint and error are both present", () => {
    render(
      <TextField label="Password" hint="At least 12 characters" error="Too short" />,
    );
    const input = screen.getByLabelText("Password");
    const hint = screen.getByText("At least 12 characters");
    const error = screen.getByText("Too short");

    const describedBy = input.getAttribute("aria-describedby")?.split(" ");
    expect(describedBy).toEqual(expect.arrayContaining([hint.id, error.id]));
  });

  it("multiline renders a <textarea> with the same label wiring", () => {
    render(<TextField label="Paste your contract" multiline />);
    const field = screen.getByLabelText("Paste your contract");
    expect(field.tagName).toBe("TEXTAREA");
  });

  it("passes through standard input props (placeholder, value, onChange)", () => {
    render(
      <TextField
        label="Email address"
        placeholder="you@studio.com"
        value=""
        onChange={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText("you@studio.com")).toBeInTheDocument();
  });

  it("has no axe violations, with and without an error", async () => {
    const { container: clean } = render(<TextField label="Email address" />);
    expect(await axe(clean)).toHaveNoViolations();

    const { container: invalid } = render(
      <TextField label="Email address" error="Enter a valid email address" />,
    );
    expect(await axe(invalid)).toHaveNoViolations();
  });
});
