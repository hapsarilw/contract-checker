import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState } from "react";
import Tabs from "../../src/components/Tabs.jsx";

const TABS = [
  { id: "file", label: "Upload a file" },
  { id: "paste", label: "Paste the text" },
];

function Harness() {
  const [activeId, setActiveId] = useState("file");
  return (
    <Tabs label="Upload method" tabs={TABS} activeId={activeId} onChange={setActiveId}>
      {activeId === "file" ? <p>Drop the contract here</p> : <p>Paste it below</p>}
    </Tabs>
  );
}

describe("Tabs (BUILD-PLAN step 30, WAI-ARIA APG tabs pattern)", () => {
  it("renders a tablist with the given label and both tabs", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Upload method" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Upload a file" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Paste the text" })).toBeInTheDocument();
  });

  it("marks exactly one tab selected, and its panel is labelled by it", () => {
    render(<Harness />);
    const fileTab = screen.getByRole("tab", { name: "Upload a file" });
    const pasteTab = screen.getByRole("tab", { name: "Paste the text" });

    expect(fileTab).toHaveAttribute("aria-selected", "true");
    expect(pasteTab).toHaveAttribute("aria-selected", "false");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAccessibleName("Upload a file");
    expect(screen.getByText("Drop the contract here")).toBeInTheDocument();
  });

  it("a roving tabindex: only the selected tab is in the Tab sequence", () => {
    render(<Harness />);
    expect(screen.getByRole("tab", { name: "Upload a file" })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(screen.getByRole("tab", { name: "Paste the text" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("clicking a tab selects it and swaps the panel", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("tab", { name: "Paste the text" }));

    expect(screen.getByRole("tab", { name: "Paste the text" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Paste it below")).toBeInTheDocument();
  });

  it("ArrowRight/ArrowLeft move focus AND selection between tabs, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    screen.getByRole("tab", { name: "Upload a file" }).focus();
    await user.keyboard("{ArrowRight}");

    const pasteTab = screen.getByRole("tab", { name: "Paste the text" });
    expect(document.activeElement).toBe(pasteTab);
    expect(pasteTab).toHaveAttribute("aria-selected", "true");

    // Wraps: ArrowRight from the last tab goes back to the first.
    await user.keyboard("{ArrowRight}");
    const fileTab = screen.getByRole("tab", { name: "Upload a file" });
    expect(document.activeElement).toBe(fileTab);
    expect(fileTab).toHaveAttribute("aria-selected", "true");

    // Wraps the other way too: ArrowLeft from the first tab goes to the last.
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(pasteTab);
  });

  it("Home/End jump to the first/last tab", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    screen.getByRole("tab", { name: "Upload a file" }).focus();
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Paste the text" }),
    );

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Upload a file" }),
    );
  });

  it("has no axe violations", async () => {
    const { container } = render(<Harness />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
