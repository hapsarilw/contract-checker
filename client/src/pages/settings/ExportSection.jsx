import { useState } from "react";
import { apiFetch, ApiError } from "../../api/client.js";
import Button from "../../components/Button.jsx";
import SettingsSection from "./SettingsSection.jsx";

/**
 * FR-4.5 / PRD §12.5: everything held about the person, as one JSON file.
 *
 * Fetched through the ordinary API client (so a 429 arrives as the
 * server's own message, "you've requested 3 data exports today...") and
 * handed to the browser as a download. The body is parsed and
 * re-serialised, which pretty-prints it; that costs some memory for a
 * large account and buys a file a person can actually open in an editor.
 * FR-2.13 caps an account at 50 MB of stored text, so the ceiling is
 * known.
 *
 * The file name carries the date, the same reason the server's
 * Content-Disposition does: someone who exports twice should not have to
 * guess which file is which. It is computed here, because the API client
 * returns the parsed body and not the response headers.
 */
export default function ExportSection() {
  const [phase, setPhase] = useState(
    /** @type {"idle" | "preparing" | "done" | "error"} */ ("idle"),
  );
  const [message, setMessage] = useState("");

  async function handleClick() {
    if (phase === "preparing") return;
    setPhase("preparing");
    setMessage("Preparing your file. Large accounts can take a moment.");
    try {
      const data = await apiFetch("/api/v1/account/export");
      const filename = `clausecheck-export-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setPhase("done");
      setMessage(`Downloaded ${filename}.`);
    } catch (err) {
      setPhase("error");
      setMessage(
        err instanceof ApiError
          ? err.message
          : "Something went wrong. Try again in a moment.",
      );
    }
  }

  return (
    <SettingsSection title="Download your data">
      <p className="cc-settings__lede">
        One file with your account details, every contract with its full text, every
        report and finding, and your security history. You can download it 3 times a day.
      </p>
      <div className="cc-settings__actions">
        <Button
          variant="secondary"
          onClick={handleClick}
          disabled={phase === "preparing"}
        >
          {phase === "preparing" ? "Preparing…" : "Download my data"}
        </Button>
        <p
          role="status"
          aria-live="polite"
          className={`cc-settings__status ${phase === "error" ? "cc-settings__status--error" : ""}`.trim()}
        >
          {message}
        </p>
      </div>
    </SettingsSection>
  );
}
