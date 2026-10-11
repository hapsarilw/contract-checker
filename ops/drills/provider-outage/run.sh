#!/usr/bin/env bash
# BUILD-PLAN step 75 / PRD §9, Phase 1.5 DoD item 3: the provider-outage
# drill, end to end, on this machine. See drill.mjs for what it measures
# and compose.yml for the stack.
#
#   ops/drills/provider-outage/run.sh                    an outage on a busy day
#   DRILL_THINK_MS=60000 ops/drills/provider-outage/run.sh   on a quiet one
#   DRILL_FAULT=database ops/drills/provider-outage/run.sh   Postgres stopped instead
#   DRILL_FAULT=redis ops/drills/provider-outage/run.sh      Redis stopped instead (FR-5.6)
#
# Results go to $DRILL_RESULTS_DIR (default: a new temporary directory,
# printed at the start): result.json, the notifications Alertmanager sent,
# and the logs. The stack is removed at the end unless KEEP_STACK=1.
#
# Shares ports and the Compose project with ops/deploy/rehearsal and
# ops/load: one of them at a time.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
OUT="${DRILL_RESULTS_DIR:-$(mktemp -d)}"
mkdir -p "$OUT/notifications" "$OUT/mail-sink"
# The recorder and the API containers write here as their own users.
chmod 777 "$OUT/notifications" "$OUT/mail-sink"

export DRILL_DIR="$ROOT/ops/drills/provider-outage"
export ALERTS_DIR="$ROOT/ops/alerts"
export DRILL_OUT="$OUT/notifications"
export DRILL_ALERTMANAGER_CONFIG="$OUT/alertmanager.yml"
export API_IMAGE_TAG=drill-current
# Short enough that p95 stays far from analysis_latency_p95's 45 s, so the
# only thing that can fire is what the outage causes.
export MOCK_LLM_DELAY_MS=3000
export MOCK_LLM_FINDINGS=quote-document
export PROXY_TIMEOUT_SECONDS=150
export MAIL_SINK_HOST_DIR="$OUT/mail-sink"
COMPOSE_FILES=(-f ops/deploy/rehearsal/compose.yml -f "$DRILL_DIR/compose.yml")
COMPOSE=(docker compose "${COMPOSE_FILES[@]}")
STAMP="$(date +%m%d%H%M)"

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
grep -q "JWT_SECRET: rehearsal-only-jwt-secret-32-bytes-minimum-x" ops/deploy/rehearsal/compose.yml || {
  echo "the rehearsal's JWT_SECRET no longer matches this script's; minted sessions would be refused" >&2
  exit 2
}
ops() { (cd server && env "${OPS_ENV[@]}" node scripts/ops.js "$@"); }

cleanup() {
  "${COMPOSE[@]}" logs --no-color >"$OUT/stack.log" 2>&1 || true
  if [[ "${KEEP_STACK:-}" != 1 ]]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "results in $OUT"

# Alertmanager's configuration is the committed one with the two receiver
# URLs pointed at the recorder. Anything else differing would mean the
# drill measured a configuration that is not the one that ships.
sed -e 's#https://REPLACE-WITH-PAGING-PROVIDER.invalid/clausecheck-page#http://recorder:9000/page#' \
    -e 's#https://REPLACE-WITH-DIGEST-DESTINATION.invalid/clausecheck-digest#http://recorder:9000/digest#' \
    ops/alerts/alertmanager.yml >"$DRILL_ALERTMANAGER_CONFIG"
changed="$(diff ops/alerts/alertmanager.yml "$DRILL_ALERTMANAGER_CONFIG" | grep -c '^>' || true)"
if [[ "$changed" != 2 ]]; then
  echo "expected exactly the two receiver URLs to differ from ops/alerts/alertmanager.yml; $changed lines did" >&2
  exit 2
fi
docker run --rm -v "$ALERTS_DIR:/a:ro" --entrypoint promtool prom/prometheus:v3.7.3 check rules /a/alerts.yml >/dev/null
docker run --rm -v "$OUT:/o:ro" --entrypoint amtool prom/alertmanager:v0.28.1 check-config /o/alertmanager.yml >/dev/null

echo "== build and start: 2 x api, nginx, Postgres, Redis, Prometheus, Alertmanager, the recorder"
docker build -q --build-arg GIT_SHA="$(git rev-parse --short HEAD)" -t "clausecheck-server:$API_IMAGE_TAG" server >/dev/null
"${COMPOSE[@]}" up -d --wait postgres redis >/dev/null 2>&1
(cd server && DATABASE_URL=postgresql://rehearsal:rehearsal@127.0.0.1:55432/rehearsal npx prisma migrate deploy >/dev/null)
# A healthy environment's scheduled jobs have succeeded recently. A fresh
# database says they never have, and retention_job_stale would fire for
# that before any outage. The drill needs a quiet baseline (drill.mjs's
# first gate checks it), not a job history.
"${COMPOSE[@]}" exec -T postgres psql -U rehearsal -d rehearsal -v ON_ERROR_STOP=1 -qc \
  "insert into \"JobRun\" (job, \"lastSuccessAt\") values ('retention', now()), ('quota-reset', now()), ('backup-verify', now())
   on conflict (job) do update set \"lastSuccessAt\" = excluded.\"lastSuccessAt\", \"lastFailureAt\" = null, \"lastFailureReason\" = null"
"${COMPOSE[@]}" up -d --wait api1 api2 >/dev/null 2>&1
"${COMPOSE[@]}" up -d proxy recorder alertmanager prometheus >/dev/null 2>&1
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:58080/api/ready >/dev/null && break; sleep 1; done
# Both instances scraped before the clock starts.
for _ in $(seq 1 60); do
  scraped=no
  curl -fs 'http://127.0.0.1:59090/api/v1/query?query=sum(up%7Bjob%3D%22clausecheck-api%22%7D)' | grep -q '"value":\[[0-9.]*,"2"\]' && { scraped=yes; break; }
  sleep 2
done
[[ "$scraped" == yes ]] || { echo "Prometheus is not scraping both API instances" >&2; exit 2; }

ops load-accounts --run "drill-$STAMP" --count 80 --out "$OUT/sessions.json" >/dev/null

# A laptop that idles into sleep mid-drill stops every clock the drill
# reads: the first run's did, 2.4 minutes into the outage, and slept on and
# off for an hour. caffeinate holds the machine awake while the drill runs,
# where there is one (macOS); drill.mjs's first gate still checks.
awake() { if command -v caffeinate >/dev/null; then caffeinate -i "$@"; else "$@"; fi; }

set +e
awake node "$DRILL_DIR/drill.mjs" --sessions "$OUT/sessions.json" --notifications "$OUT/notifications" \
  --compose-file ops/deploy/rehearsal/compose.yml --compose-file "$DRILL_DIR/compose.yml" \
  --think-ms "${DRILL_THINK_MS:-2000}" --fault "${DRILL_FAULT:-provider}" \
  --out "$OUT/result.json" 2>&1 | tee "$OUT/drill.log"
code=${PIPESTATUS[0]}
set -e
rm -f "$OUT/sessions.json"
echo "results in $OUT"
exit "$code"
