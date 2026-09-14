import { Component } from "react";
import Banner from "./Banner.jsx";
import Button from "./Button.jsx";
import "./ErrorBoundary.css";

/**
 * BUILD-PLAN step 31, FR-7.11 — "A React error boundary wraps each route
 * and renders a recoverable error with the requestId when one is known,
 * instead of a blank page. Unhandled client errors are reported without
 * any document content attached."
 *
 * A class component because React has no hook equivalent for
 * `getDerivedStateFromError`/`componentDidCatch` — this is the one
 * primitive in this codebase that has to be one.
 *
 * Step 39 wraps every route in this; nothing here is route-specific.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
function requestIdOf(error) {
  // Duck-typed rather than `instanceof ApiError`: an error boundary must
  // not assume WHERE an error came from (a render bug has nothing to do
  // with the API client), only recognise a requestId when the thrown
  // value happens to carry one.
  return error &&
    typeof error === "object" &&
    "requestId" in error &&
    typeof (/** @type {{ requestId?: unknown }} */ (error).requestId) === "string"
    ? /** @type {{ requestId: string }} */ (error).requestId
    : undefined;
}

/**
 * The FR-7.11 half this function exists to guarantee: only fields known
 * in advance to be safe (an error's own message/name/stack, and a
 * requestId if it has one) ever leave this function. Never the error
 * object itself, never React's componentStack (component names only,
 * but still not a field this function chooses to trust), and never
 * anything from props or state — a caught render error could be thrown
 * from deep inside a component tree holding a whole Document/Analysis
 * in props, and "the error mentions what it was rendering" is exactly
 * the leak FR-2.7's "no document content in logs" rule (which this
 * mirrors) exists to prevent.
 *
 * The default implementation only logs to the console — there is no
 * error-reporting endpoint yet. `report` is a prop specifically so a
 * later step can wire one without editing this component: it always
 * receives this same pre-sanitised payload, never the raw error.
 *
 * @param {unknown} error
 */
function defaultReport(error) {
  const safe = {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    requestId: requestIdOf(error),
  };
  // The deliberate fallback reporter until a real error-tracking endpoint exists.
  console.error("[ErrorBoundary]", safe);
}

/**
 * @typedef {{
 *   children: import("react").ReactNode,
 *   report?: (error: unknown) => void,
 * }} Props
 * @typedef {{ error: unknown }} State
 * @extends {Component<Props, State>}
 */
export default class ErrorBoundary extends Component {
  /** @param {Props} props */
  constructor(props) {
    super(props);
    /** @type {State} */
    this.state = { error: null };
  }

  /** @param {unknown} error */
  static getDerivedStateFromError(error) {
    return { error };
  }

  /** @param {unknown} error */
  componentDidCatch(error) {
    (this.props.report ?? defaultReport)(error);
  }

  render() {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }

    const requestId = requestIdOf(error);

    return (
      <div className="cc-error-boundary">
        <h1 className="cc-error-boundary__title">Something went wrong</h1>
        <Banner tone="danger" title="This page hit an unexpected error">
          Try again, or come back in a moment. Nothing you were working on was lost on our
          end.
        </Banner>
        {requestId ? (
          <p className="cc-error-boundary__request-id">
            Reference: <code>{requestId}</code>
          </p>
        ) : null}
        <div className="cc-error-boundary__action">
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      </div>
    );
  }
}
