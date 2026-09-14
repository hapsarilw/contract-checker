import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState } from "react";
import Dialog from "../../src/components/Dialog.jsx";

/**
 * A trigger button plus the dialog it opens, mirroring how Dialog is
 * actually used — this is what lets the focus-restoration tests assert
 * against a real "what had focus before" element, not an assumption.
 */
/** @param {{ tone?: "default" | "danger" }} props */
function Harness({ tone } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Delete permanently
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Delete this contract permanently?"
        description="This can't be undone."
        tone={tone}
      >
        <button type="button" onClick={() => setOpen(false)}>
          Delete permanently
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Keep it
        </button>
      </Dialog>
    </div>
  );
}

describe("Dialog (BUILD-PLAN step 30)", () => {
  it("is absent from the DOM when closed, and present with dialog semantics when open", () => {
    render(<Dialog open={false} onClose={() => {}} title="x" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    render(<Dialog open onClose={() => {}} title="Delete this contract permanently?" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Delete this contract permanently?");
  });

  it("links the description via aria-describedby when one is given", () => {
    render(
      <Dialog open onClose={() => {}} title="Delete?" description="This can't be undone.">
        x
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleDescription("This can't be undone.");
  });

  it("moves focus into the dialog when it opens", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toContainElement(
        /** @type {HTMLElement | null} */ (document.activeElement),
      );
    });
  });

  it("restores focus to the trigger when it closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Delete permanently" });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Keep it" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("traps Tab inside the dialog — Tab from the last control wraps to the first", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    const dialog = screen.getByRole("dialog");
    const [firstButton, lastButton] = Array.from(dialog.querySelectorAll("button"));

    lastButton.focus();
    await user.tab();
    expect(document.activeElement).toBe(firstButton);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(lastButton);
  });

  it("clicking the scrim (not the panel) closes the dialog", async () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Delete?">
        x
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    const scrim = /** @type {HTMLElement} */ (dialog.parentElement);

    scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("danger tone applies the accent class, for a destructive confirmation", () => {
    render(
      <Dialog open onClose={() => {}} title="Delete?" tone="danger">
        x
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toHaveClass("cc-dialog--danger");
  });

  it("has no axe violations", async () => {
    render(
      <Dialog
        open
        onClose={() => {}}
        title="Delete this contract permanently?"
        tone="danger"
      >
        <button type="button">Delete permanently</button>
        <button type="button">Keep it</button>
      </Dialog>,
    );
    // axe needs a container that actually contains the portalled content
    // — Dialog renders into document.body via createPortal, so the check
    // runs against document.body rather than the render() result's
    // (empty) container.
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
