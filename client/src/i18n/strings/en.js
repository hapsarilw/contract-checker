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
  // Step 36 — the finding card's severity line (the prototype builds it
  // as `label + sevSuffix` in English but `sevSuffix + label` in
  // Indonesian; spelled out per locale so word order isn't code).
  findingSeverity: {
    HIGH: "High severity",
    MEDIUM: "Medium severity",
    LOW: "Low severity",
  },
  // Step 36 — the prototype's GLOSS[*].en, keyed as in
  // pages/glossaryTerms.js. The Indonesian term name the prototype also
  // showed inside the English popover (GLOSS[*].id) is not carried over:
  // Phase 1 copy is English-only (FR-7.14).
  glossary: {
    assignment: "Permanently transferring ownership of the work to someone else.",
    indemnity:
      "A promise to cover the other side’s losses if a claim is made against them.",
    noncompete: "A promise not to work for competing businesses for a set period.",
    killfee: "A payment owed if the client cancels after the work has started.",
    net90: "Payment falls due 90 days after the trigger date, not on delivery.",
    net60: "Payment falls due 60 days after the invoice date.",
    acceptance: "The client’s formal sign-off — it can start or delay the payment clock.",
    liabilitycap: "A ceiling on the total amount you could owe if something goes wrong.",
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
  // Step 38 — the prototype's two `historyBlurb` variants (its own
  // sc-if on `s.screen === 'history-empty'`), and the history-empty
  // screen's title/body/CTA, which the prototype treats as literals
  // rather than L-map entries but are ported here the same way every
  // other prototype string on a real screen is.
  historyBlurbFull: "Open a report again, or delete a contract for good.",
  historyBlurbEmpty: "Every contract you check is listed here.",
  historyEmptyTitle: "No contracts checked yet.",
  historyEmptyBody:
    "When you check a contract it’ll be listed here with its risk level, so you can open the report again later — or delete it.",
  historyEmptyCta: "Check your first contract",
  // Not in the prototype: its demo rows always have a completed
  // analysis. A real row can lack one (uploaded, never analyzed, or an
  // analyze attempt that failed) — FR-4.1's `overallRisk`/`findingCount`
  // are then `null`/`0`, and showing "No findings" for THAT would claim
  // a clean result that was never actually checked for.
  historyNotAnalyzed: "Not yet analyzed",
  historyNoFindings: "No findings",
  deleteRow: "Delete",
  loadMore: "Load more",
  loadingMore: "Loading…",
};
