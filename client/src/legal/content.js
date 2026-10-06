/**
 * BUILD-PLAN step 74 / PRD §12: the privacy policy, the terms of service
 * and the subprocessor list, as data. LegalPage.jsx renders them; nothing
 * here is markup.
 *
 * DRAFTS UNTIL THEY ARE NOT. Every value the owner has still to supply is
 * written as a bracketed placeholder, `[LIKE THIS]`. `unresolved()` finds
 * them, and LegalPage shows a "draft, not yet in force" banner listing
 * them for as long as any remain, so a half-finished policy cannot pass
 * for a finished one. The banner is computed from this content, not from
 * a flag someone has to remember to clear.
 *
 * EVERY FACTUAL CLAIM HERE IS ONE THE SYSTEM KEEPS, OR ONE A PROVIDER
 * VERIFIABLY MAKES:
 * - the retention periods are SRS §5.6's, enforced by the nightly job;
 * - the backup window is PRD §12.4's, and the policy says plainly that a
 *   deleted document persists there for up to 30 days;
 * - the Anthropic statements were checked against Anthropic's own pages
 *   on 2026-10-05 (docs/legal/verification.md: wording, dates, hashes);
 * - the statutory clocks are UU PDP's, GDPR's and the UK GDPR's, the
 *   strictest of the three (same file).
 * If the system changes, this changes with it.
 *
 * PRD §12.2 applies to every word: no "legal review", no "lawyer-approved",
 * no "protects you". client/tests/unit/uplCopy.test.js enforces it here
 * as everywhere else.
 *
 * Not legal advice, and not reviewed by counsel. PRD §17 requires that
 * review before public launch.
 */

export const LEGAL_UPDATED = "2026-10-05";

/** The verification record these documents rest on. */
export const VERIFICATION_RECORD = "docs/legal/verification.md";

/**
 * A paragraph is a string; a list is { list: string[] }; a table is
 * { table: { head: string[], rows: string[][] } }.
 *
 * @typedef {string | { list: string[] } | { table: { head: string[], rows: string[][] } }} Block
 * @typedef {{ heading: string, blocks: Block[] }} Section
 * @typedef {{ slug: string, title: string, summary: string, sections: Section[] }} LegalDocument
 */

/** @type {LegalDocument} */
export const privacy = {
  slug: "privacy",
  title: "Privacy policy",
  summary:
    "What ClauseCheck collects, why, who else handles it, how long it is kept, and how to see, change or delete it.",
  sections: [
    {
      heading: "Who is responsible for your data",
      blocks: [
        "ClauseCheck is operated by [OPERATOR] (“we”). We are the controller of your account data and of the documents you upload or paste: we decide why and how they are processed.",
        "Privacy questions and requests: [PRIVACY CONTACT EMAIL].",
        "This policy is written for the laws we have declared that we follow: Indonesia’s Law No. 27 of 2022 on Personal Data Protection (UU PDP), the EU General Data Protection Regulation (GDPR), and the UK GDPR. Where they differ, we apply the strictest of them.",
      ],
    },
    {
      heading: "What we collect",
      blocks: [
        {
          list: [
            "Account data: your email address, a one-way hash of your password (never the password itself), whether you have verified your address, and when you signed up.",
            "Your documents: the text extracted from the file you upload or paste, its file name and word count, and the reports produced from it (the clauses quoted, the explanations and the suggested asks).",
            "Security records: sign-ins, password changes and similar events. The person and the network address in these records are stored only as keyed hashes, not as readable identifiers.",
            "Operational data: request counts, timings and error rates, with no document content in them.",
          ],
        },
        "We set one cookie, which keeps you signed in. We use no analytics, advertising or tracking cookies, and no third-party scripts run on report pages.",
      ],
    },
    {
      heading: "Why we use it, and on what basis",
      blocks: [
        {
          table: {
            head: ["Purpose", "UU PDP basis", "GDPR / UK GDPR basis"],
            rows: [
              [
                "Analysing the documents you submit, and keeping your reports so you can open them again",
                "Performance of a contract with you (Art. 20(2)(b))",
                "Contract (Art. 6(1)(b))",
              ],
              [
                "Running your account: sign-in, email verification, password reset",
                "Performance of a contract (Art. 20(2)(b))",
                "Contract (Art. 6(1)(b))",
              ],
              [
                "Security and abuse prevention: rate limits, security records, investigating misuse",
                "Legitimate interest (Art. 20(2)(f))",
                "Legitimate interests (Art. 6(1)(f))",
              ],
              [
                "Meeting legal obligations, such as answering a lawful request",
                "Legal obligation (Art. 20(2)(c))",
                "Legal obligation (Art. 6(1)(c))",
              ],
            ],
          },
        },
        "We do not sell your data, and we do not use your documents for anything except producing your reports.",
      ],
    },
    {
      heading: "Who else handles your documents",
      blocks: [
        "To analyse a document, we send its text to our AI provider, Anthropic. Anthropic processes it on our behalf under a Data Processing Addendum that is part of its Commercial Terms of Service.",
        "Anthropic’s Commercial Terms state: “Anthropic may not train models on Customer Content from Services.” Your documents are not used to train AI models. (We checked this against the terms in effect from 17 June 2025, on 2026-10-05, and re-check it every year and whenever the terms change.)",
        "Anthropic deletes what we send it, and what it sends back, within 30 days. It may keep content longer only if it is flagged as violating Anthropic’s usage policy (up to 2 years) or where the law requires it.",
        "The analysis may run in any of the regions where Anthropic operates, so your document may be processed outside your own country. [CROSS-BORDER TRANSFER SAFEGUARDS: TO BE CONFIRMED BY COUNSEL]",
        "Every company that handles your data for us is named on the subprocessor list, with what it does and where.",
      ],
    },
    {
      heading: "How long we keep it",
      blocks: [
        {
          table: {
            head: ["Data", "Kept for"],
            rows: [
              [
                "Documents and their reports",
                "90 days from upload, or until you delete them, whichever is first",
              ],
              ["Your account", "Until you delete it"],
              ["Security records", "13 months"],
              ["Server logs (no document text in them)", "30 days"],
              ["Operational metrics (no content in them)", "13 months"],
              ["Backups of our database", "30 days, then destroyed"],
            ],
          },
        },
        "Deleting is immediate and permanent in the service itself: there is no undo. It is not immediate everywhere. A deleted document or account still exists in our database backups until those backups age out, which takes up to 30 days. Backups are used only to recover from a failure, and if one is ever restored, anything you had deleted is deleted again.",
      ],
    },
    {
      heading: "Your rights",
      blocks: [
        {
          table: {
            head: ["Right", "How", "How fast"],
            rows: [
              [
                "See and take a copy of your data",
                "Settings → Download your data (a JSON file with your account, documents and reports)",
                "Immediately, yourself",
              ],
              [
                "Delete your data",
                "Delete a document from its report; delete everything from Settings → Delete my account",
                "Immediately, yourself; backups within 30 days",
              ],
              [
                "Correct your data",
                "Settings → Change your email (it changes once you open the link we send to the new address) or Change your password; for anything else, write to us",
                "Immediately, yourself",
              ],
              [
                "Withdraw, object, or ask us to stop or restrict processing",
                "Delete your account, or write to us",
                "Within 72 hours of your request",
              ],
              [
                "Any of the above by email",
                "Write to [PRIVACY CONTACT EMAIL] from your account’s address; we confirm it is you before acting",
                "Within 72 hours of your request",
              ],
            ],
          },
        },
        "72 hours is the time UU PDP sets for access, correction, and stopping or restricting processing (Articles 30, 32, 40 and 41). It is also well inside the GDPR’s one month, so it is what we commit to for everyone.",
        "You can also complain to a data protection authority: in Indonesia, the authority designated under UU PDP; in the EU, the supervisory authority where you live or work; in the UK, the Information Commissioner’s Office.",
      ],
    },
    {
      heading: "If something goes wrong",
      blocks: [
        "If personal data we hold is exposed, we tell the people affected, and the authority, in writing within 72 hours of finding out. That is the time UU PDP sets (Article 46), and the GDPR and UK GDPR set the same 72 hours for telling the authority.",
        "How we protect what we hold: encryption in transit, passwords stored only as salted hashes, each document shown only to the account that uploaded it, no document text in our logs, and error reports stripped of request contents before they leave our servers.",
      ],
    },
    {
      heading: "What ClauseCheck does not offer",
      blocks: [
        "So that you can judge whether it suits your situation: ClauseCheck has no SOC 2, HIPAA or ISO 27001 certification, offers no choice of where your data is stored, and does not support enterprise single sign-on. It is not for anyone under 18.",
      ],
    },
    {
      heading: "Changes to this policy",
      blocks: [
        "If we change this policy in a way that matters, we email you before the change takes effect. The date it was last updated is shown at the top.",
      ],
    },
  ],
};

/** @type {LegalDocument} */
export const terms = {
  slug: "terms",
  title: "Terms of service",
  summary:
    "The agreement between you and ClauseCheck, including what it is, what it is not, and what you may not use it for.",
  sections: [
    {
      heading: "The agreement",
      blocks: [
        "These terms are an agreement between you and [OPERATOR], who operates ClauseCheck. By creating an account you accept them. You must be 18 or over.",
        "[GOVERNING LAW AND VENUE: TO BE SET BY COUNSEL]",
        "[LANGUAGE OF THE AGREEMENT: COUNSEL TO CONFIRM WHETHER AN INDONESIAN VERSION IS REQUIRED (LAW NO. 24 OF 2009)]",
      ],
    },
    {
      heading: "What ClauseCheck is, and what it is not",
      blocks: [
        "ClauseCheck is an automated tool. It reads a contract, points at clauses that may work against you, explains them in plain language, and suggests what you might ask for instead.",
        "It is not a lawyer and not a law firm, and it does not give legal advice. Using it does not create an attorney-client relationship, or any other professional relationship, with us or with anyone else.",
        "Its output can be wrong or incomplete. It can miss a clause that matters, flag one that does not, or misjudge how serious something is. It does not know your jurisdiction, your situation or what has been agreed outside the document. Every clause it quotes comes from your own document, so check each one against the page.",
      ],
    },
    {
      heading: "No reliance",
      blocks: [
        "You use ClauseCheck’s output at your own judgement. Do not rely on it as a substitute for advice from a qualified lawyer, especially where a lot is at stake. A report that finds nothing does not mean a contract is safe to sign.",
      ],
    },
    {
      heading: "Your documents",
      blocks: [
        "Your documents remain yours. You allow us to process them only to produce your reports and to keep them for the periods in the privacy policy.",
        "Only upload a document you have the right to share with a service like this one. Many contracts, and the agreements around them, are confidential. Whether you may upload one is your responsibility, not ours.",
      ],
    },
    {
      heading: "What you may not do",
      blocks: [
        {
          list: [
            "Upload a document you have no right to share.",
            "Try to extract, reveal or override the instructions ClauseCheck gives its AI model.",
            "Submit documents in bulk or by automated means, or try to get around the usage limits.",
            "Use ClauseCheck’s output as a substitute for legal advice in a high-stakes matter.",
            "Use ClauseCheck to break the law, or to harm anyone.",
          ],
        },
        "We enforce limits first. We suspend an account only for repeated, deliberate misuse. When we do, we say why, record it, and you can appeal by writing to [SUPPORT CONTACT EMAIL]. We never read your documents to decide whether you have misused the service; we judge only from how the service is used.",
      ],
    },
    {
      heading: "Limits and availability",
      blocks: [
        "Each account has usage limits (for example, a number of analyses per hour and per month), shown in the product. ClauseCheck is run by a small team, without round-the-clock support. We aim to keep it available but do not guarantee it, and an analysis may occasionally fail.",
      ],
    },
    {
      heading: "Liability",
      blocks: ["[LIMITATION OF LIABILITY: TO BE DRAFTED BY COUNSEL]"],
    },
    {
      heading: "Ending the agreement",
      blocks: [
        "You can stop at any time by deleting your account in Settings, which deletes your documents and reports at once (and from backups within 30 days). We may suspend or close an account that breaks these terms, as described above.",
      ],
    },
    {
      heading: "Changes and contact",
      blocks: [
        "If we change these terms in a way that matters, we email you before the change takes effect. Questions: [SUPPORT CONTACT EMAIL].",
      ],
    },
  ],
};

/** @type {LegalDocument} */
export const subprocessors = {
  slug: "subprocessors",
  title: "Subprocessors",
  summary:
    "Every company that processes personal data for ClauseCheck, what it does, and where.",
  sections: [
    {
      heading: "Current list",
      blocks: [
        {
          table: {
            head: ["Company", "What it does for ClauseCheck", "What it handles", "Where"],
            rows: [
              [
                "Anthropic (Anthropic, PBC; or Anthropic Ireland, Limited where the operator is in the EEA, Switzerland or the UK)",
                "Analyses each document (the AI model)",
                "Document text, and the analysis it returns",
                "Any region where Anthropic operates (its default “global” processing); stored up to 30 days",
              ],
              [
                "[HOSTING PROVIDER: NOT YET CHOSEN]",
                "Runs the ClauseCheck service",
                "Everything the service handles, in transit",
                "[REGION]",
              ],
              [
                "[DATABASE PROVIDER: NOT YET CHOSEN]",
                "Stores accounts, documents and reports, and their backups",
                "All stored data",
                "[REGION]",
              ],
              [
                "[CACHE PROVIDER: NOT YET CHOSEN]",
                "Counts requests for rate limits",
                "Account ids and network addresses, briefly",
                "[REGION]",
              ],
              [
                "[EMAIL PROVIDER: NOT YET CHOSEN]",
                "Sends verification, password-reset and account emails",
                "Your email address and the email’s contents",
                "[REGION]",
              ],
              [
                "Sentry [LEGAL ENTITY: TO BE CONFIRMED]",
                "Receives reports of server errors",
                "The error type, where in the code it happened, and the route; never the request’s contents, and on document and account routes not even the error message",
                "[SENTRY DATA REGION: US OR EU, NOT YET CHOSEN]",
              ],
            ],
          },
        },
        "We add a company to this list before it starts processing your data, and email you if the change is material.",
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS = Object.freeze({ privacy, terms, subprocessors });

const PLACEHOLDER = /\[[A-Z][A-Z0-9 :,.'()’/-]*\]/g;

/**
 * Every placeholder still in a document, once each, in order of appearance.
 * @param {LegalDocument} doc
 * @returns {string[]}
 */
export function unresolved(doc) {
  /** @type {string[]} */
  const strings = [];
  for (const section of doc.sections) {
    strings.push(section.heading);
    for (const block of section.blocks) {
      if (typeof block === "string") strings.push(block);
      else if ("list" in block) strings.push(...block.list);
      else strings.push(...block.table.head, ...block.table.rows.flat());
    }
  }
  return [...new Set(strings.flatMap((s) => s.match(PLACEHOLDER) ?? []))];
}
