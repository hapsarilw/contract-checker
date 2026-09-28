#!/usr/bin/env bash
# BUILD-PLAN step 70 (OPS-7) — applies docs/branch-protection.md's decision
# to the real repository, as one command rather than a list of clicks in
# the GitHub UI that nobody can diff or re-run. Read that file first; this
# script is its executable half, not a second source of truth for what the
# settings are — every value below exists because that file explains it.
#
# Usage:
#   scripts/configure-branch-protection.sh            # apply
#   scripts/configure-branch-protection.sh --dry-run   # print the request body, change nothing
#
# Needs: `gh`, authenticated (`gh auth status`) against a token with repo
# admin rights on hapsarilw/contract-checker.
#
# WHY THIS HAS TO RUN AFTER CI's FIRST REAL RUN, NOT BEFORE. GitHub's
# required-status-checks API accepts any check NAME you give it — it does
# not validate that a check by that name has ever reported — so running
# this before .github/workflows/ci.yml has executed at least once (on any
# branch or PR) does not fail loudly. It silently requires a check that
# will never appear, which means the branch can never be merged into at
# all. Push a branch, open one PR, let CI finish, THEN run this script.

set -euo pipefail

REPO="hapsarilw/contract-checker"
BRANCH="main"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if ! $DRY_RUN && ! command -v gh >/dev/null 2>&1; then
  echo "gh (GitHub CLI) is required — https://cli.github.com" >&2
  exit 1
fi

# The required checks are the job names in .github/workflows/ci.yml,
# exactly. server/tests/unit/ciPipeline.test.js asserts this list matches
# that file's actual job names, so this array and that workflow cannot
# drift against each other without a test noticing — but this script and
# that test are still two places naming the same twelve strings, and if
# you add a job, update both.
CHECKS=(
  server-quality
  client-quality
  server-tests
  client-build
  client-e2e
  docker-build
  dependency-scan
  image-scan
  secret-scan
  openapi-contract-test
  fixtures-verify
)

CONTEXTS_JSON=$(printf '%s\n' "${CHECKS[@]}" | node -e '
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  rl.on("line", (l) => lines.push(l));
  rl.on("close", () => process.stdout.write(JSON.stringify(lines)));
')

# GitHub's branch protection PUT replaces the WHOLE protection config, not
# a diff against what is already there — every field this project cares
# about has to be in this one payload, or a manual UI change made later
# would be silently reverted the next time this script runs. See
# docs/branch-protection.md for what require_pull_request_reviews can and
# cannot enforce at one-maintainer scale (self-approval is not blockable
# on this account tier); require_code_owner_reviews is what CODEOWNERS
# needs to actually route a review request on the four SRS §12.1 paths.
BODY=$(cat <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ${CONTEXTS_JSON}
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
)

if $DRY_RUN; then
  echo "Would PUT to /repos/${REPO}/branches/${BRANCH}/protection:"
  echo "${BODY}" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")), null, 2))'
  exit 0
fi

echo "${BODY}" | gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/branches/${BRANCH}/protection" \
  --input -

echo "Branch protection applied to ${REPO}#${BRANCH}."
