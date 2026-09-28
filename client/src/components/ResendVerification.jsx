import { useState } from "react";
import { apiFetch, ApiError } from "../api/client.js";
import Button from "./Button.jsx";
import "./ResendVerification.css";

/**
 * "Send the link again", with its outcome told in place. Shared by the two
 * screens that need it (the verification prompt on the upload screen, and
 * the failure state of /verify-email), so the two cannot disagree about
 * what a resend does or says.
 *
 * WHAT IT CALLS: POST /api/v1/auth/resend-verification (FR-1.7), which
 * needs a signed-in session, is limited to 3 per hour per account and 10
 * per hour per IP, and answers `{ sent, alreadyVerified }`. The limit's
 * message is the server's own ("...3 times in the last hour... try again
 * in about N minutes") and is shown as it arrives: it already says what
 * happened and when to come back, and rewording it here would only put
 * two copies of that sentence out of step.
 *
 * ALREADY VERIFIED is a success, not an error: the account was verified in
 * another tab or on another device since this page loaded. The caller is
 * told, so it can refresh the session and let the prompt go away.
 *
 * The outcome sits in a `role="status"` region that is ALWAYS rendered,
 * empty until there is something to say. A live region that appears in the
 * DOM at the same moment as its content is announced unreliably, which is
 * the reason CopyButton does the same.
 *
 * @param {{ email?: string, onAlreadyVerified?: () => void }} props
 */
export default function ResendVerification({ email, onAlreadyVerified }) {
  const [state, setState] = useState(
    /** @type {{ phase: "idle" | "sending" | "sent" | "error", message: string }} */ ({
      phase: "idle",
      message: "",
    }),
  );

  async function resend() {
    setState({ phase: "sending", message: "" });
    try {
      const body = /** @type {{ sent: boolean, alreadyVerified: boolean }} */ (
        await apiFetch("/api/v1/auth/resend-verification", { method: "POST" })
      );
      if (body.alreadyVerified) {
        setState({ phase: "sent", message: "Your email is already verified." });
        onAlreadyVerified?.();
        return;
      }
      setState({
        phase: "sent",
        message: `We sent a new link${email ? ` to ${email}` : ""}. It can take a minute, and it may land in your spam folder.`,
      });
    } catch (err) {
      setState({
        phase: "error",
        message:
          err instanceof ApiError
            ? err.message
            : "Something went wrong. Try again in a moment.",
      });
    }
  }

  return (
    <div className="cc-resend">
      <Button variant="secondary" onClick={resend} disabled={state.phase === "sending"}>
        {state.phase === "sending"
          ? "Sending…"
          : state.phase === "sent"
            ? "Send it again"
            : "Send the link again"}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className={`cc-resend__status ${state.phase === "error" ? "cc-resend__status--error" : ""}`.trim()}
      >
        {state.message}
      </p>
    </div>
  );
}
