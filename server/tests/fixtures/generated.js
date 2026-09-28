// SRS §11.1 fixtures 10 to 12, which have no text source, GENERATED AT TEST
// TIME and never committed (BUILD-PLAN step 72): the repository runs secret
// and dependency scanning and is public, and scanners and some git hosts
// flag or refuse a committed zip bomb. Each is defined once, here, as the
// function that builds it; answerKey.js records what intake must do with
// it, and tests/unit/intake.test.js holds the two against each other
// exactly as it does for the committed fixtures.
//
// The builders are tests/helpers/hostileFiles.js's, the ones TR-18's own
// tests use, so "fixture 10" and "TR-18's zip bomb" are the same file, not
// two approximations of one.

import { buildPdf, buildZipBomb } from "../helpers/hostileFiles.js";

/** @type {Record<string, Record<string, () => Promise<Buffer>>>} */
export const generatedFixtures = {
  // 10 MB of zeros in one entry: an expansion ratio in the thousands against
  // FR-2.9's limit of 100.
  "10-zip-bomb": { docx: () => buildZipBomb({ megabytes: 10 }) },
  "11-encrypted": { pdf: () => buildPdf({ password: "fixture-11-not-a-secret" }) },
  // One page past FR-2.10's 100, and a few hundred words: under the word cap
  // by a wide margin, so only the page limit can refuse it.
  "12-many-pages": { pdf: () => buildPdf({ pages: 101 }) },
};
