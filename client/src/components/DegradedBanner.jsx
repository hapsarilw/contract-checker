import { Link } from "react-router";
import { describeWait } from "../api/degraded.js";
import { useDegraded } from "../api/useDegraded.js";
import Banner from "./Banner.jsx";

/**
 * FR-7.10's persistent banner. The title is the SRS's own sentence.
 *
 * It says three things, in the order a person needs them: checking is off
 * (the title), why, and when it comes back, plus a way to what still
 * works. PRD D13 keeps every read path up during an outage on purpose, so
 * the banner points at the saved reports rather than leaving the person
 * looking at a dead button.
 *
 * `role="status"`: it can appear while the person is on the page (coming
 * back from a failed check), and a polite announcement is right for a
 * standing condition; an alert would be for something that just broke in
 * their hands, and the error card they just saw already was that.
 *
 * The wait it states is the server's own estimate (Retry-After) as it was
 * when the outage was learned, not a countdown: a countdown would need
 * the clock read during render, and a number that ticks reads as more
 * precise than the estimate behind it.
 *
 * Renders nothing when analysis is available.
 */
export default function DegradedBanner() {
  const degraded = useDegraded();
  if (!degraded) return null;

  // The breaker's outage is described in our words; the spend cutoff in
  // the server's, which differ between a ceiling and an operator's pause
  // (FR-5.4) and must not be flattened into one.
  const why =
    degraded.code === "LLM_UNAVAILABLE"
      ? "The service that reads contracts isn’t answering, so checking a new contract is switched off instead of failing one attempt at a time."
      : degraded.message;

  return (
    <Banner
      tone="warning"
      role="status"
      title="Analysis is temporarily unavailable — your saved reports are still here"
    >
      {why} Checking switches back on here {describeWait(degraded.seconds * 1000)}.{" "}
      <Link to="/documents">Go to your saved reports</Link>
    </Banner>
  );
}
