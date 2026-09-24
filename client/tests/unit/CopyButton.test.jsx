import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import CopyButton from "../../src/components/CopyButton.jsx";

const PROPS = {
  text: "Please cap total liability at the contract value.",
  label: "Copy this ask",
  copiedLabel: "Copied",
  announcement: "Copied. Paste it into your reply to the client.",
};

describe("CopyButton (BUILD-PLAN step 30, SRS §7.15 Copy control row)", () => {
  beforeEach(() => {
    // jsdom has no Clipboard implementation of its own.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("is keyboard-operable: a real <button>, reachable and clickable via Enter", () => {
    render(<CopyButton {...PROPS} />);
    expect(screen.getByRole("button", { name: PROPS.label })).toBeInTheDocument();
  });

  it("copies the given text to the clipboard on click", async () => {
    render(<CopyButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: PROPS.label }));
    await vi.waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(PROPS.text),
    );
  });

  it("swaps the visible label to the confirmed state", async () => {
    render(<CopyButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: PROPS.label }));
    expect(
      await screen.findByRole("button", { name: PROPS.copiedLabel }),
    ).toBeInTheDocument();
  });

  it("announces the confirmation via a polite live region, empty before any copy", async () => {
    render(<CopyButton {...PROPS} />);
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");

    fireEvent.click(screen.getByRole("button", { name: PROPS.label }));

    await vi.waitFor(() => expect(live).toHaveTextContent(PROPS.announcement));
  });

  it("never moves focus away from the button when it confirms", async () => {
    render(<CopyButton {...PROPS} />);
    const button = screen.getByRole("button", { name: PROPS.label });
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(PROPS.announcement),
    );

    // Still the same element (now re-labelled "Copied") — clicking or
    // confirming never called .focus() on anything else.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: PROPS.copiedLabel }),
    );
  });

  it("a failed copy leaves the button unchanged and announces nothing", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<CopyButton {...PROPS} />);

    fireEvent.click(screen.getByRole("button", { name: PROPS.label }));

    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: PROPS.label })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  describe("reverts to the normal state after a delay", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("reverts the label and clears the announcement", async () => {
      render(<CopyButton {...PROPS} />);

      // Not vi.waitFor()/findBy* here: both poll on a real setTimeout
      // internally, which fake timers freeze — awaiting the resolved
      // clipboard mock's microtask directly is what actually lets
      // handleClick's `await navigator.clipboard.writeText(...)`, and
      // the setCopied(true) after it, run to completion.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: PROPS.label }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: PROPS.copiedLabel })).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(2500));

      expect(screen.getByRole("button", { name: PROPS.label })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("");
    });
  });

  it("has no axe violations, in both the normal and confirmed state", async () => {
    const { container } = render(<CopyButton {...PROPS} />);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole("button", { name: PROPS.label }));
    await screen.findByRole("button", { name: PROPS.copiedLabel });
    expect(await axe(container)).toHaveNoViolations();
  });
});
