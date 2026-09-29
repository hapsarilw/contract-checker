#!/usr/bin/env bash
# BUILD-PLAN step 71: the local deploy rehearsal. See compose.yml's header for
# what this is and is not, and docs/deployment.md for what it proved.
#
#   ops/deploy/rehearsal/run.sh
#   PREVIOUS_REF=<commit> ops/deploy/rehearsal/run.sh
#
# Needs Docker and Node (for the host-side migration step and the checks).
# Takes about five minutes: three of the analyses are held for 50 s on
# purpose. Leaves nothing behind: the stack and its volume are removed on
# exit, pass or fail. The two images it builds are kept (tagged
# rehearsal-current and rehearsal-previous) so a re-run is faster.
#
# Scenarios, each with the outcome it REQUIRES — a scenario that fails in the
# expected way is a pass, which is how the first one proves the check can
# tell a truncated analysis from a finished one:
#   1. migrations run as a discrete step, before any API instance exists
#   2. a 50 s analysis through a 30 s proxy               -> must FAIL
#   3. the same through a 150 s proxy                     -> must PASS
#   4. a rolling restart of both instances while a 50 s analysis is in
#      flight, with a smoke probe running throughout      -> analysis PASSES,
#                                                            no probe fails
#   5. rollback: the previous image against the current schema, including a
#      row only the current code can write                -> smoke PASSES,
#                                                            an analysis PASSES
#   6. roll forward again                                 -> smoke PASSES
#   7. the built client, served statically, against this API, driven by
#      e2e/staging.spec.js with nothing mocked             -> PASSES, axe clean

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f ops/deploy/rehearsal/compose.yml)
export DEPLOY_BASE_URL="http://127.0.0.1:58080"
export SMOKE_ACCOUNT_EMAIL="smoke@rehearsal.invalid"
SMOKE_ACCOUNT_PASSWORD="rehearsal-$(openssl rand -hex 12)-Aa1"
export SMOKE_ACCOUNT_PASSWORD
export SYNTHETIC_CHECK_TOKEN="rehearsal-only-synthetic-token-32-bytes-x"
PG_URL="postgresql://rehearsal:rehearsal@127.0.0.1:55432/rehearsal"
CHECKS="ops/deploy/checks.mjs"
WORK="$(mktemp -d)"
# The mail sink, bind-mounted into both instances. Created here, writable by
# the containers' uid: left to Docker, a missing bind source is created
# root-owned on Linux and every email write fails.
mkdir -p "$WORK/mail-sink" && chmod 777 "$WORK/mail-sink"
export MAIL_SINK_HOST_DIR="$WORK/mail-sink"

# The previous release: by default the commit just before the newest
# migration landed, i.e. code that has never seen the current schema. That
# is the hardest rollback there is today; nothing is deployed yet, so there
# is no "actually previous" release to use instead.
NEWEST_MIGRATION_COMMIT="$(git log -1 --format=%H -- server/prisma/migrations)"
PREVIOUS_REF="${PREVIOUS_REF:-${NEWEST_MIGRATION_COMMIT}^}"
PREV_SHA="$(git rev-parse --short "$PREVIOUS_REF")"
CUR_SHA="$(git rev-parse --short HEAD)"
git diff --quiet HEAD -- server || CUR_SHA="${CUR_SHA}-dirty"

PASSED=()
FAILED=()
result() { if [[ "$1" == ok ]]; then PASSED+=("$2"); echo "  => ok: $2"; else FAILED+=("$2"); echo "  => FAILED: $2"; fi; }
step() { printf '\n== %s\n' "$*"; }
psql_q() { "${COMPOSE[@]}" exec -T postgres psql -U rehearsal -d rehearsal -tAc "$1"; }
roll() { # roll <image tag> <instance>...: one at a time, each healthy before the next
  local tag="$1"; shift
  for instance in "$@"; do
    local t0; t0=$(date +%s)
    API_IMAGE_TAG="$tag" "${COMPOSE[@]}" up -d --no-deps --force-recreate --wait "$instance" >/dev/null 2>&1
    # An idle instance stops at once; one that waited out an in-flight
    # request's drain took that long. This line is the evidence scenario 4
    # actually stopped the instance holding the analysis.
    echo "  $instance -> $tag in $(( $(date +%s) - t0 )) s"
  done
}
# expect <exit code> <label> <command...>
expect() {
  local want="$1" label="$2"; shift 2
  set +e; "$@"; local got=$?; set -e
  if [[ "$got" == "$want" ]]; then result ok "$label"; else result fail "$label (exit $got, wanted $want)"; fi
}

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step "build: current ($CUR_SHA) and previous ($PREV_SHA, $(git log -1 --format=%s "$PREVIOUS_REF"))"
docker build -q --build-arg GIT_SHA="$CUR_SHA" -t clausecheck-server:rehearsal-current server >/dev/null
git archive "$PREVIOUS_REF" server | tar -x -C "$WORK"
docker build -q --build-arg GIT_SHA="$PREV_SHA" -t clausecheck-server:rehearsal-previous "$WORK/server" >/dev/null
echo "  built"

step "1. migrations, as a discrete step, before any API instance exists"
export API_IMAGE_TAG=rehearsal-current
"${COMPOSE[@]}" up -d --wait postgres redis >/dev/null 2>&1
running="$("${COMPOSE[@]}" ps --services --status running | tr '\n' ' ')"
echo "  running before migrating: $running"
(cd server && DATABASE_URL="$PG_URL" npx prisma migrate deploy >/dev/null)
applied="$(psql_q 'select count(*) from "_prisma_migrations" where finished_at is not null')"
expected="$(find server/prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[[ "$applied" == "$expected" && "$running" != *api* ]] && result ok "1. $applied/$expected migrations applied with no API running" || result fail "1. migrations ($applied/$expected applied; running: $running)"

step "current image, two instances, behind a 30 s proxy"
PROXY_TIMEOUT_SECONDS=30 "${COMPOSE[@]}" up -d --wait api1 api2 >/dev/null 2>&1
PROXY_TIMEOUT_SECONDS=30 "${COMPOSE[@]}" up -d proxy >/dev/null 2>&1
for _ in $(seq 1 30); do curl -fs "$DEPLOY_BASE_URL/api/ready" >/dev/null && break; sleep 1; done
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DEPLOY_BASE_URL/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SMOKE_ACCOUNT_EMAIL\",\"password\":\"$SMOKE_ACCOUNT_PASSWORD\"}")"
# Staging's smoke account is verified through the real email flow, once. The
# rehearsal's sink is inside a read-only container, so it is verified here.
psql_q "update \"User\" set state = 'ACTIVE', \"emailVerifiedAt\" = now() where email = '$SMOKE_ACCOUNT_EMAIL'" >/dev/null
echo "  smoke account registered ($status) and verified"

step "2. a 50 s analysis through a 30 s proxy must be CUT, and the check must say so"
expect 1 "2. 30 s proxy truncates the analysis and the check fails" node "$CHECKS" long-analysis

step "3. the same analysis through a 150 s proxy"
PROXY_TIMEOUT_SECONDS=150 "${COMPOSE[@]}" up -d --no-deps --force-recreate proxy >/dev/null 2>&1
for _ in $(seq 1 30); do curl -fs "$DEPLOY_BASE_URL/api/ready" >/dev/null && break; sleep 1; done
expect 0 "3. 150 s proxy lets a 50 s analysis complete" node "$CHECKS" long-analysis

step "4. rolling restart of both instances while a 50 s analysis is in flight"
node "$CHECKS" long-analysis >"$WORK/inflight.log" 2>&1 &
inflight=$!
: >"$WORK/probes.log"
( while [[ ! -f "$WORK/stop-probes" ]]; do
    if DEPLOY_EXPECTED_SHA="$CUR_SHA" node "$CHECKS" smoke >"$WORK/probe.out" 2>&1; then echo ok >>"$WORK/probes.log"
    else { echo FAIL; cat "$WORK/probe.out"; } >>"$WORK/probes.log"; fi
    sleep 2
  done ) &
prober=$!
sleep 8
started=$(date +%s)
roll rehearsal-current api1 api2
echo "  rolled both instances in $(( $(date +%s) - started )) s"
set +e; wait "$inflight"; inflight_exit=$?; set -e
touch "$WORK/stop-probes"; wait "$prober" || true
sed 's/^/  analysis: /' "$WORK/inflight.log"
probes_ok="$(grep -c '^ok$' "$WORK/probes.log" || true)"
probes_failed="$(grep -c '^FAIL$' "$WORK/probes.log" || true)"
echo "  smoke probes during the roll: $probes_ok ok, $probes_failed failed"
[[ "$probes_failed" != 0 ]] && grep -A12 '^FAIL$' "$WORK/probes.log" | sed 's/^/    /' | head -40
[[ "$inflight_exit" == 0 ]] && result ok "4a. the in-flight analysis survived the rolling restart" || result fail "4a. in-flight analysis (exit $inflight_exit)"
[[ "$probes_failed" == 0 && "$probes_ok" -gt 0 ]] && result ok "4b. no smoke probe failed during the roll ($probes_ok probes)" || result fail "4b. $probes_failed of $((probes_ok + probes_failed)) probes failed during the roll"

step "5. rollback: the previous image ($PREV_SHA) against the current schema"
null_rows="$(psql_q 'select count(*) from "JobRun" where "lastSuccessAt" is null')"
echo "  JobRun rows only the current code can write (lastSuccessAt NULL): $null_rows"
[[ "$null_rows" -gt 0 ]] && result ok "5a. the rollback faces a row the previous code never wrote" || result fail "5a. no NULL lastSuccessAt row to face (the scenario did not set itself up)"
roll rehearsal-previous api1 api2
expect 0 "5b. smoke on the previous image: every instance on $PREV_SHA, ready, signed-in round trip" \
  env DEPLOY_EXPECTED_SHA="$PREV_SHA" node "$CHECKS" smoke
expect 0 "5c. an analysis on the previous image" env LONG_ANALYSIS_MIN_SECONDS=0 node "$CHECKS" long-analysis
# The previous code's own read of every JobRun row (its metrics gauge's
# collect(), jobs/jobRuns.js at that commit), run inside the previous image:
# does its Prisma client accept a NULL it was generated to believe
# impossible? The gauge swallows the error and logs it, so no HTTP check
# would ever see this; it is asked directly.
set +e
probe="$("${COMPOSE[@]}" exec -T api1 node --input-type=module -e '
  const { default: prisma } = await import("/app/src/lib/prisma.js");
  try { const rows = await prisma.jobRun.findMany(); console.log("read", rows.length, "rows"); process.exit(0); }
  catch (err) { console.log("threw:", String(err.message).split("\n").filter(Boolean).slice(-1)[0]); process.exit(1); }
' 2>&1)"
probe_exit=$?
set -e
echo "  previous code reading every JobRun row: $probe"
[[ "$probe_exit" == 0 ]] && result ok "5d. the previous code reads the NULL row without error" || result fail "5d. the previous code cannot read a row the current code writes"

step "6. roll forward again"
roll rehearsal-current api1 api2
expect 0 "6. smoke on the current image after rolling forward" env DEPLOY_EXPECTED_SHA="$CUR_SHA" node "$CHECKS" smoke

step "7. e2e/staging.spec.js: the built client against this API, nothing mocked"
# What deploy.yml's verify-staging runs, pointed here: the client built for
# this API (VITE_API_BASE_URL), served as the static files it is, and the
# spec that signs in, runs an analysis (held 50 s by the mock), reads the
# report and history, deletes, signs out, with axe on every screen.
(cd client && VITE_API_BASE_URL="$DEPLOY_BASE_URL" npm run build >/dev/null 2>&1)
(cd client && exec npx vite preview --host 127.0.0.1 --port 4173 --strictPort >"$WORK/preview.log" 2>&1) &
preview=$!
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:4173/ >/dev/null && break; sleep 1; done
set +e
(cd client && PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173 E2E_STAGING=1 \
  E2E_ACCOUNT_EMAIL="$SMOKE_ACCOUNT_EMAIL" E2E_ACCOUNT_PASSWORD="$SMOKE_ACCOUNT_PASSWORD" \
  npx playwright test e2e/staging.spec.js --reporter=line --retries=0 >"$WORK/e2e.log" 2>&1)
e2e_exit=$?
set -e
kill "$preview" 2>/dev/null || true
tail -n 25 "$WORK/e2e.log" | sed 's/^/  /'
left="$(psql_q "select count(*) from \"Document\" d join \"User\" u on u.id = d.\"userId\" where u.email = '$SMOKE_ACCOUNT_EMAIL'")"
[[ "$e2e_exit" == 0 ]] && result ok "7a. the staging spec passes against a real API, axe clean on every screen" || result fail "7a. the staging spec (exit $e2e_exit)"
[[ "$left" == 0 ]] && result ok "7b. it left none of its documents behind" || result fail "7b. $left of the smoke account's documents left behind"

printf '\n== summary: %d passed, %d failed\n' "${#PASSED[@]}" "${#FAILED[@]}"
for f in "${FAILED[@]+"${FAILED[@]}"}"; do echo "  FAILED: $f"; done
[[ "${#FAILED[@]}" == 0 ]]
