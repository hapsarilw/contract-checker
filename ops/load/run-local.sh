#!/usr/bin/env bash
# BUILD-PLAN step 73: TR-21, TR-22, TR-23 and TR-24 against the LOCAL
# rehearsal stack (ops/deploy/rehearsal/compose.yml): two instances of the
# current image at 512 MB each behind nginx, Postgres, Redis, the mock
# provider answering after MOCK_LLM_DELAY_MS with findings that quote the
# document. SRS §10.6 says these run against STAGING; there is no staging
# yet, and docs/load-test-results.md says what that does and does not carry
# over.
#
#   ops/load/run-local.sh                  tr23 tr24 tr21 tr22 (the soak takes 2 h)
#   ops/load/run-local.sh tr21             just one
#   SOAK_MINUTES=20 ops/load/run-local.sh tr22
#
# Results (JSON, and the logs) go to $LOAD_RESULTS_DIR, default a new
# temporary directory, printed at the start. The stack is removed at the
# end unless KEEP_STACK=1.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
SCENARIOS="${*:-tr23 tr24 tr21 tr22}"
RESULTS="${LOAD_RESULTS_DIR:-$(mktemp -d)}"
mkdir -p "$RESULTS/mail-sink"
# The containers run as uid 1000 and write the sink into this directory.
chmod 777 "$RESULTS/mail-sink"
STAMP="$(date +%m%d%H%M)"
COMPOSE_FILE="ops/deploy/rehearsal/compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

export API_IMAGE_TAG=load-current
export MOCK_LLM_DELAY_MS="${MOCK_LLM_DELAY_MS:-25000}"
export MOCK_LLM_FINDINGS=quote-document
export PROXY_TIMEOUT_SECONDS=150
export MAIL_SINK_HOST_DIR="$RESULTS/mail-sink"
BASE="http://127.0.0.1:58080"
METRICS_TOKEN="rehearsal-only-metrics-token-32-bytes-min-x"

# The ops command line runs on this host against the rehearsal's database,
# with the rehearsal's JWT_SECRET, so the sessions it mints are ones the
# API accepts. These must match compose.yml; the check below enforces it.
OPS_ENV=(
  NODE_ENV=development
  DATABASE_URL=postgresql://rehearsal:rehearsal@127.0.0.1:55432/rehearsal
  REDIS_URL=redis://127.0.0.1:1
  LLM_PROVIDER=mock
  ANTHROPIC_API_KEY=rehearsal-placeholder-not-a-key
  ANTHROPIC_MODEL=claude-sonnet-5
  JWT_SECRET=rehearsal-only-jwt-secret-32-bytes-minimum-x
  AUDIT_SALT=rehearsal-only-audit-salt-32-bytes-minimum-x
  FRONTEND_ORIGIN=http://127.0.0.1:4173
  LLM_PRICE_INPUT_PER_MTOK=3
  LLM_PRICE_OUTPUT_PER_MTOK=15
  MONTHLY_SPEND_CEILING_USD=100
  LOG_LEVEL=warn
)
grep -q "JWT_SECRET: rehearsal-only-jwt-secret-32-bytes-minimum-x" "$COMPOSE_FILE" || {
  echo "compose.yml's JWT_SECRET no longer matches this script's; minted sessions would be refused" >&2
  exit 2
}
ops() { (cd server && env "${OPS_ENV[@]}" node scripts/ops.js "$@"); }

cleanup() {
  if [[ "${KEEP_STACK:-}" != 1 ]]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "results in $RESULTS"
echo "== build and start: 2 x api (512 MB), nginx, Postgres, Redis; mock latency ${MOCK_LLM_DELAY_MS} ms"
docker build -q --build-arg GIT_SHA="$(git rev-parse --short HEAD)" -t "clausecheck-server:$API_IMAGE_TAG" server >/dev/null
"${COMPOSE[@]}" up -d --wait postgres redis >/dev/null 2>&1
(cd server && DATABASE_URL=postgresql://rehearsal:rehearsal@127.0.0.1:55432/rehearsal npx prisma migrate deploy >/dev/null)
"${COMPOSE[@]}" up -d --wait api1 api2 >/dev/null 2>&1
"${COMPOSE[@]}" up -d proxy >/dev/null 2>&1
for _ in $(seq 1 30); do curl -fs "$BASE/api/ready" >/dev/null && break; sleep 1; done

# A laptop that sleeps mid-run stops every clock the run reads (step 75's
# drill: idle sleep 2.4 minutes into a 5-minute outage). caffeinate holds
# the machine awake while a scenario runs, where there is one (macOS). It
# cannot keep a battery from running out.
awake() { if command -v caffeinate >/dev/null; then caffeinate -i "$@"; else "$@"; fi; }

# Plain arrays: macOS ships bash 3.2, which has no associative ones.
SUMMARY=()
FAILED=0
verdict() { # verdict <scenario> <exit code>
  if [[ "$2" == 0 ]]; then SUMMARY+=("$1: PASS"); else SUMMARY+=("$1: FAIL (exit $2)"); FAILED=1; fi
}
load() { # load <scenario> <accounts> [extra flags...]
  local scenario="$1" count="$2"; shift 2
  local run="$scenario-$STAMP"
  ops load-accounts --run "$run" --count "$count" --out "$RESULTS/$run.sessions.json" >/dev/null
  set +e
  awake node ops/load/load.mjs "$scenario" --base-url "$BASE" --sessions "$RESULTS/$run.sessions.json" \
    --compose "$COMPOSE_FILE" --metrics-token "$METRICS_TOKEN" --per-account-address \
    --out "$RESULTS/$scenario.json" "$@" 2>&1 | tee "$RESULTS/$scenario.log"
  local code=${PIPESTATUS[0]}
  set -e
  ops load-cleanup --run "$run" >/dev/null
  rm -f "$RESULTS/$run.sessions.json"
  verdict "$scenario" "$code"
}

for scenario in $SCENARIOS; do
  printf '\n== %s\n' "$scenario"
  case "$scenario" in
    tr23) load tr23 50 --uploads 50 ;;
    tr21) load tr21 70 --minutes "${LOAD_MINUTES:-10}" --concurrency 20 --expected-latency-ms "$MOCK_LLM_DELAY_MS" ;;
    tr22) load tr22 110 --minutes "${SOAK_MINUTES:-120}" --concurrency 5 --expected-latency-ms "$MOCK_LLM_DELAY_MS" ;;
    tr24)
      (cd client && VITE_API_BASE_URL="$BASE" npm run build >/dev/null 2>&1)
      (cd client && exec npx vite preview --host 127.0.0.1 --port 4173 --strictPort >"$RESULTS/preview.log" 2>&1) &
      preview=$!
      for _ in $(seq 1 30); do curl -fs http://127.0.0.1:4173/ >/dev/null && break; sleep 1; done
      set +e
      (cd client && PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173 E2E_JOURNEY=1 E2E_MAILBOX="sink:$MAIL_SINK_HOST_DIR" \
        npx playwright test e2e/journey.spec.js --reporter=line --retries=0) 2>&1 | tee "$RESULTS/tr24.log"
      code=${PIPESTATUS[0]}
      set -e
      kill "$preview" 2>/dev/null || true
      verdict tr24 "$code"
      ;;
    *) echo "unknown scenario $scenario" >&2; exit 2 ;;
  esac
done

printf '\n== summary (results in %s)\n' "$RESULTS"
for line in "${SUMMARY[@]}"; do echo "  $line"; done
exit $FAILED
