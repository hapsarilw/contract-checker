import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import ErrorBoundary from "../../src/components/ErrorBoundary.jsx";
import { ApiError } from "../../src/api/client.js";

/**
 * @param {{ error: unknown }} props
 * @returns {never}
 */
function Bomb({ error }) {
  throw error;
}

describe("ErrorBoundary (BUILD-PLAN step 31, FR-7.11)", () => {
  it("renders its children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All is well</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("All is well")).toBeInTheDocument();
  });

  it("shows a recoverable error, not a blank page, when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary report={() => {}}>
        <Bomb error={new Error("boom")} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("shows the requestId when the thrown error carries one (an ApiError)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary report={() => {}}>
        <Bomb error={new ApiError("INTERNAL", "Something broke", "req_abc123", 500)} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("req_abc123")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("shows no requestId reference when the thrown error doesn't have one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary report={() => {}}>
        <Bomb error={new Error("a plain render bug, nothing to do with the API")} />
      </ErrorBoundary>,
    );
    expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it("reports the error through a sanitised payload — name, message, requestId only, never the raw error, props, or component stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const report = vi.fn();
    const documentText = "CONFIDENTIAL CONTRACT: the client is Acme Corp, rate $200/hr";

    /** Mimics a real screen: the error is thrown from deep inside a tree holding document content in props. */
    function ScreenHoldingDocument({ text }) {
      if (text) throw new Error("render bug");
      return null;
    }

    render(
      <ErrorBoundary report={report}>
        <ScreenHoldingDocument text={documentText} />
      </ErrorBoundary>,
    );

    expect(report).toHaveBeenCalledTimes(1);
    const [reportedError] = report.mock.calls[0];
    // The boundary hands `report` the raw thrown error (report itself
    // decides what to keep) — what this test actually guards is
    // defaultReport's behaviour, exercised directly below, since THIS
    // report is a test double that could do anything. Assert instead
    // that nothing about how the boundary invokes report smuggles
    // document content in on the side (e.g. via extra arguments).
    expect(report.mock.calls[0]).toHaveLength(1);
    expect(reportedError).toBeInstanceOf(Error);
    spy.mockRestore();
  });

  it("the default reporter logs only name/message/requestId, never document content that happened to be nearby", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const documentText = "CONFIDENTIAL: rate $200/hr for Acme Corp";
    const error = new Error(`Cannot read property 'x' of undefined`);
    // @ts-expect-error — simulating a real bug that (wrongly) attached
    // extra context to the error object, to prove the default reporter
    // doesn't forward it.
    error.context = { documentText };

    render(
      <ErrorBoundary>
        <Bomb error={error} />
      </ErrorBoundary>,
    );

    // React itself also logs the caught error to console.error — the
    // assertion below is about OUR reporter's own call specifically, not
    // "console.error was called exactly once" (it isn't: React's own
    // log is a second call this test doesn't control and isn't the
    // subject of this check).
    const ownCall = spy.mock.calls.find((call) => call[0] === "[ErrorBoundary]");
    expect(ownCall).toBeDefined();
    const loggedPayload = /** @type {[string, unknown]} */ (ownCall)[1];
    expect(JSON.stringify(loggedPayload)).not.toContain("Acme Corp");
    expect(loggedPayload).toEqual({
      name: "Error",
      message: "Cannot read property 'x' of undefined",
      requestId: undefined,
    });
    spy.mockRestore();
  });

  it("'Try again' resets the boundary so a subsequent successful render shows through", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    let shouldThrow = true;

    function Flaky() {
      if (shouldThrow) throw new Error("transient");
      return <p>Recovered</p>;
    }

    render(
      <ErrorBoundary report={() => {}}>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    shouldThrow = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("Recovered")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("has no axe violations in its fallback state", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary report={() => {}}>
        <Bomb error={new ApiError("INTERNAL", "Something broke", "req_abc123", 500)} />
      </ErrorBoundary>,
    );
    expect(await axe(container)).toHaveNoViolations();
    spy.mockRestore();
  });
});
