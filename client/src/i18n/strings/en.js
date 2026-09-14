import { DISCLAIMER_LOCKED } from "../disclaimer.js";

/**
 * BUILD-PLAN step 30 — the English half of the prototype's `L.en` map
 * (docs/design/ClauseCheck.html), ported string-for-string. `disclaimer`
 * is the one exception: it re-exports disclaimer.js's locked constant
 * rather than repeating the text here, so there is exactly one place
 * this wording lives (see disclaimer.js for why it's locked).
 *
 * Step 30 shipped the L map only — not CAT (finding-category labels),
 * GLOSS (glossary definitions), or JURIS (jurisdiction notes). Step 35
 * adds `severity` and `categories` (this file's version of SEV.label and
 * CAT, needed for the report's risk header and category breakdown); GLOSS
 * arrives with step 36's finding cards. JURIS does not arrive at all in
 * Phase 1 (decision D-A, option A1 — cut, not deferred).
 */
export const en = {
  navNew: "New contract",
  navHistory: "History",
  navSignOut: "Sign out",
  back: "Back to history",
  overallRisk: "Overall risk",
  shape: "The shape of it",
  where: "Where the problems are",
  filterAll: "All",
  // BUILD-PLAN step 35 — the prototype's SEV.label/labelId, keyed by the
  // server's actual Severity enum values (HIGH/MEDIUM/LOW,
  // server/prisma/schema.prisma) rather than the prototype's lowercase
  // demo-data keys, so a report component can index this directly with
  // a real finding's `severity` field.
  severity: { HIGH: "High", MEDIUM: "Medium", LOW: "Low" },
  // The prototype's CAT.en, keyed by the server's Category enum values
  // for the same reason.
  categories: {
    PAYMENT: "Payment",
    IP: "IP and ownership",
    SCOPE: "Scope and revisions",
    TERMINATION: "Termination",
    LIABILITY: "Liability",
    CONFIDENTIALITY: "Confidentiality",
    DISPUTE: "Dispute resolution",
    OTHER: "Other",
  },
  findingsHead: "Clauses worth a second look",
  orderNote: "Highest severity first",
  quotedFrom: "Quoted from your contract",
  why: "Why it matters",
  ask: "What to ask for",
  copyLabel: "Copy this ask",
  copiedLabel: "Copied",
  copiedNote: "Copied — paste it into your reply to the client.",
  missingHead: "Protections the contract doesn’t include",
  missingSub:
    "These are standard terms in freelance agreements. Nothing here is quoted, because there’s nothing to quote — that’s the point. They don’t change the risk level above, and they’re the easiest thing to ask for while the contract is still open.",
  jurisHead: "Notes on your jurisdiction",
  disclaimer: DISCLAIMER_LOCKED.en,
  doneHead: "Done with this contract?",
  doneBody: "Deleting removes the document and this report from our database entirely.",
  deleteCta: "Delete permanently",
  delKeep: "Keep it",
  delHead: "Delete this contract permanently?",
  delBody:
    "The document and this report will be removed from our database. This can’t be undone, and we won’t be able to recover them for you.",
  findingWord: ["finding", "findings"],
  noneFlagged: "No clauses flagged",
  showingAll: "showing all ",
  showing: "showing ",
  of: " of ",
  sevSuffix: " severity",
  quoteNote: null,
};
