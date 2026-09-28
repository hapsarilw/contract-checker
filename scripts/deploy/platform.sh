#!/usr/bin/env bash
# BUILD-PLAN step 71: the ONE place .github/workflows/deploy.yml touches a
# hosting platform. Everything else in the deploy — the image, the discrete
# migration step, the smoke check, the 15-minute watch, the approval gate,
# rollback-by-image — is platform-independent and already built.
#
#   scripts/deploy/platform.sh deploy-api      <staging|production> <image ref>
#   scripts/deploy/platform.sh deploy-frontend <staging|production> <dist dir>
#
# deploy-api must: roll the API service of that environment onto exactly
# that image, one instance at a time, each given a stop grace period above
# the 90 s drain (NFR-3.5), and return only once every instance runs it.
# checks.mjs smoke then PROVES the last part by sampling /api/version.
#
# deploy-frontend must: publish that directory as the environment's static
# site, keeping the previous build addressable, so rolling the frontend back
# is re-publishing an earlier build (PRD §15), independent of the API.
#
# NO PLATFORM HAS BEEN CHOSEN (docs/deployment.md, "Decisions still
# owed"). Until one is, this exits non-zero, loudly, the same way the
# server refuses to boot in production with the sink email provider: a
# deploy pipeline that "succeeds" without deploying anything is the worst
# possible failure mode for it. Adding a platform is one case below.

set -euo pipefail

action="${1:-}"
environment="${2:-}"
artifact="${3:-}"

case "$environment" in
  staging | production) ;;
  *) echo "usage: $0 deploy-api|deploy-frontend staging|production <image|dir>" >&2; exit 2 ;;
esac
[[ -n "$artifact" ]] || { echo "missing the image or directory to deploy" >&2; exit 2; }

case "${DEPLOY_PLATFORM:-}" in
  "")
    echo "::error::No hosting platform has been chosen, so nothing was deployed ($action $environment $artifact). See docs/deployment.md, 'Decisions still owed'." >&2
    exit 1
    ;;
  *)
    echo "::error::Unknown DEPLOY_PLATFORM '${DEPLOY_PLATFORM}': add it to scripts/deploy/platform.sh." >&2
    exit 1
    ;;
esac
