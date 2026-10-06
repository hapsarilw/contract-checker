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
# STEP 75 CHOSE (docs/deployment.md §9, docs/staging-setup.md):
#
#   API       DEPLOY_PLATFORM=render     PLATFORM_TOKEN = a Render API key,
#                                        RENDER_SERVICE_ID = that environment's
#                                        web service (srv-...)
#   frontend  FRONTEND_PLATFORM=netlify  FRONTEND_PLATFORM_TOKEN = a Netlify
#                                        personal access token,
#                                        NETLIFY_SITE_ID = that environment's site
#
# With no platform set this still exits non-zero, loudly: a deploy pipeline
# that "succeeds" without deploying anything is the worst possible failure
# mode for it. CURL is overridable for the tests, which stand a fake in for
# the platforms' APIs; nothing else is.

set -euo pipefail

action="${1:-}"
environment="${2:-}"
artifact="${3:-}"
CURL="${CURL:-curl}"
# How long a deploy may take before this gives up, and how often it looks.
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-1200}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"

case "$environment" in
  staging | production) ;;
  *) echo "usage: $0 deploy-api|deploy-frontend staging|production <image|dir>" >&2; exit 2 ;;
esac
[[ -n "$artifact" ]] || { echo "missing the image or directory to deploy" >&2; exit 2; }

need() { # need <variable name> <what it is>
  if [[ -z "${!1:-}" ]]; then
    echo "::error::$1 is not set: $2 (docs/staging-setup.md)." >&2
    exit 2
  fi
}

# poll <label> <command printing the current state> <done state> <failed states regex>
poll() {
  local label="$1" probe="$2" done_state="$3" failed="$4" state="" waited=0
  while (( waited < POLL_TIMEOUT_SECONDS )); do
    state="$(eval "$probe")"
    echo "$label: $state"
    if [[ "$state" == "$done_state" ]]; then return 0; fi
    if [[ "$state" =~ ^($failed)$ ]]; then
      echo "::error::$label ended $state." >&2
      return 1
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    waited=$(( waited + POLL_INTERVAL_SECONDS ))
  done
  echo "::error::$label did not finish within ${POLL_TIMEOUT_SECONDS}s (last state: ${state:-none})." >&2
  return 1
}

# ------------------------------------------------------------------ Render
# A deploy of an image-backed web service, pinned to the exact image. Render
# starts the new instances, waits for /api/ready (the service's health check),
# then stops the old ones with the service's shutdown delay (100 s in
# ops/render/*.yaml, over the 90 s drain). "live" is reported only once that
# is done.
render_deploy_api() {
  need PLATFORM_TOKEN "the Render API key for this environment"
  need RENDER_SERVICE_ID "this environment's Render web service id (srv-...)"
  local api="https://api.render.com/v1/services/${RENDER_SERVICE_ID}"
  local auth="Authorization: Bearer ${PLATFORM_TOKEN}"
  local body deploy_id
  body="$("$CURL" -fsS -X POST "$api/deploys" -H "$auth" -H "Content-Type: application/json" \
    -d "{\"imageUrl\": \"${artifact}\", \"clearCache\": \"do_not_clear\"}")"
  deploy_id="$(jq -r '.id // empty' <<<"$body")"
  [[ -n "$deploy_id" ]] || { echo "::error::Render did not return a deploy id." >&2; exit 1; }
  echo "Render deploy $deploy_id of $artifact to $environment"
  poll "render deploy $deploy_id" \
    "\"\$CURL\" -fsS \"$api/deploys/$deploy_id\" -H \"$auth\" | jq -r '.status'" \
    "live" \
    "build_failed|update_failed|canceled|deactivated|pre_deploy_failed"
}

# ----------------------------------------------------------------- Netlify
# A zip of the built directory, as a new deploy of the environment's site.
# Every Netlify deploy keeps its own URL and can be re-published from the
# site's deploy list, which is what rolling the frontend back is (PRD §15).
netlify_deploy_frontend() {
  need FRONTEND_PLATFORM_TOKEN "the Netlify access token for this environment"
  need NETLIFY_SITE_ID "this environment's Netlify site id"
  [[ -d "$artifact" ]] || { echo "::error::$artifact is not a directory." >&2; exit 2; }
  local api="https://api.netlify.com/api/v1"
  local auth="Authorization: Bearer ${FRONTEND_PLATFORM_TOKEN}"
  local zip body deploy_id
  zip="$(mktemp -d)/site.zip"
  (cd "$artifact" && zip -qr "$zip" .)
  body="$("$CURL" -fsS -X POST "$api/sites/${NETLIFY_SITE_ID}/deploys" -H "$auth" \
    -H "Content-Type: application/zip" --data-binary "@$zip")"
  deploy_id="$(jq -r '.id // empty' <<<"$body")"
  [[ -n "$deploy_id" ]] || { echo "::error::Netlify did not return a deploy id." >&2; exit 1; }
  echo "Netlify deploy $deploy_id of $artifact to $environment"
  poll "netlify deploy $deploy_id" \
    "\"\$CURL\" -fsS \"$api/deploys/$deploy_id\" -H \"$auth\" | jq -r '.state'" \
    "ready" \
    "error|rejected"
}

case "$action" in
  deploy-api)
    case "${DEPLOY_PLATFORM:-}" in
      render) render_deploy_api ;;
      "")
        echo "::error::No hosting platform has been chosen, so nothing was deployed ($action $environment $artifact). See docs/deployment.md, 'Decisions still owed'." >&2
        exit 1
        ;;
      *)
        echo "::error::Unknown DEPLOY_PLATFORM '${DEPLOY_PLATFORM}': add it to scripts/deploy/platform.sh." >&2
        exit 1
        ;;
    esac
    ;;
  deploy-frontend)
    case "${FRONTEND_PLATFORM:-}" in
      netlify) netlify_deploy_frontend ;;
      "")
        echo "::error::No hosting platform has been chosen for the frontend, so nothing was deployed ($action $environment $artifact). See docs/deployment.md, 'Decisions still owed'." >&2
        exit 1
        ;;
      *)
        echo "::error::Unknown FRONTEND_PLATFORM '${FRONTEND_PLATFORM}': add it to scripts/deploy/platform.sh." >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "usage: $0 deploy-api|deploy-frontend staging|production <image|dir>" >&2
    exit 2
    ;;
esac
