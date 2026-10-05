#!/usr/bin/env bash
# BUILD-PLAN step 74 / NFR-3.6 / PRD §14.2: the timed restore drill. RTO 4 h,
# RPO 24 h, "a restore rehearsed and timed at least every 6 months". The
# procedure it rehearses is docs/runbooks/database-restore.md; the result is
# recorded there. "A successful restore with no recorded duration does not
# satisfy the DoD": this prints the duration, step by step.
#
#   scripts/restore-drill.sh                     # projected year-one size
#   DRILL_DOCS=2000 scripts/restore-drill.sh     # smaller, for a quick check
#
# WHAT IT DOES, all in throwaway containers (nothing is shared with anyone's
# development database, and nothing is left behind):
#   setup   a "production" Postgres, migrated, filled with SYNTHETIC data at
#           a production-like volume, and the API image built. Not timed:
#           in a real incident all of this already exists.
#   backup  pg_dump -Fc, the custom format the runbook restores from. Timed
#           for information (it bounds the RPO side), not part of the RTO.
#   RTO     the clock that matters, from "we need the data back" to "the API
#           answers ready on the restored data":
#             1. provision a new, empty Postgres
#             2. pg_restore the backup into it
#             3. verify: every table's row count and a checksum of every
#                document's text and every finding's excerpt, against the
#                original; and Prisma's migration status
#             4. start the API against the restored database: /api/ready 200
#
# WHAT IT DOES NOT MEASURE, stated so the number is not over-read: noticing
# the incident, deciding to restore, the managed provider's own restore or
# point-in-time recovery, and pointing production at the new database.
# docs/runbooks/database-restore.md carries the full RTO budget.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Projected year-one volume, pessimistic (docs/runbooks/database-restore.md
# explains each number). All synthetic.
USERS="${DRILL_USERS:-5000}"
DOCS="${DRILL_DOCS:-20000}"
FINDINGS_PER="${DRILL_FINDINGS_PER:-6}"
AUDIT="${DRILL_AUDIT:-250000}"
DOC_KB="${DRILL_DOC_KB:-24}"

NET="restore-drill-$$"
SRC="restore-drill-src-$$"
DST="restore-drill-dst-$$"
API="restore-drill-api-$$"
REDIS="restore-drill-redis-$$"
WORK="$(mktemp -d)"
PG_IMAGE="postgres:15-alpine"
IMAGE="clausecheck-server:restore-drill"

cleanup() {
  docker rm -f "$SRC" "$DST" "$API" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

now() { node -e 'process.stdout.write(String(Date.now()))'; }
secs() { node -e "process.stdout.write(((${2} - ${1}) / 1000).toFixed(1))"; }
psql_in() { docker exec -i "$1" psql -U drill -d drill -v ON_ERROR_STOP=1 -tA "${@:2}"; }
wait_pg() { for _ in $(seq 1 60); do docker exec "$1" pg_isready -U drill -d drill >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
start_pg() { # start_pg <name> <host port>
  docker run -d --name "$1" --network "$NET" -e POSTGRES_USER=drill -e POSTGRES_PASSWORD=drill \
    -e POSTGRES_DB=drill -p "127.0.0.1:$2:5432" "$PG_IMAGE" >/dev/null
  wait_pg "$1"
  # pg_isready can answer during the image's first-boot restart; wait for a real query.
  for _ in $(seq 1 60); do psql_in "$1" -c "select 1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  return 1
}

# Every table's row count, and checksums of the text a restore must not lose.
VERIFY_SQL='
select '"'"'User'"'"', count(*)::text from "User"
union all select '"'"'Document'"'"', count(*)::text from "Document"
union all select '"'"'Analysis'"'"', count(*)::text from "Analysis"
union all select '"'"'Finding'"'"', count(*)::text from "Finding"
union all select '"'"'AuditEvent'"'"', count(*)::text from "AuditEvent"
union all select '"'"'Document.rawText md5'"'"', md5(string_agg(md5("rawText"), '"''"' order by id)) from "Document"
union all select '"'"'Finding.clauseExcerpt md5'"'"', md5(string_agg(md5("clauseExcerpt"), '"''"' order by id)) from "Finding";'

echo "== setup (not timed): synthetic production-sized database, ${USERS} users, ${DOCS} documents of ~${DOC_KB} KB"
docker network create "$NET" >/dev/null
start_pg "$SRC" 55501
(cd server && DATABASE_URL=postgresql://drill:drill@127.0.0.1:55501/drill npx prisma migrate deploy >/dev/null)
t0=$(now)
psql_in "$SRC" >/dev/null <<SQL
-- Synthetic only (SRS §2.3, §11): random hex, so the text is as
-- incompressible as real prose would be to TOAST, not a repeated phrase
-- Postgres would shrink to nothing.
insert into "User" (id, email, "passwordHash", state, "emailVerifiedAt", "updatedAt")
select 'u' || g, 'drill-' || g || '@drill.invalid', '\$2b\$12\$' || md5(g::text), 'ACTIVE', now(), now()
from generate_series(1, ${USERS}) g;

insert into "Document" (id, "userId", filename, "sourceType", "rawText", "textSha256", "wordCount", "byteSize", "createdAt")
select 'd' || g, 'u' || (1 + g % ${USERS}), 'contract-' || g || '.pdf', 'UPLOAD_PDF',
       t.text, md5(t.text), ${DOC_KB} * 1024 / 33, length(t.text), now() - (g % 90) * interval '1 day'
from generate_series(1, ${DOCS}) g
cross join lateral (
  -- w, the inner series, keeps the aggregate inside this subquery; an
  -- argument naming only the outer g makes Postgres treat it as the outer
  -- query's aggregate.
  select string_agg(md5(random()::text || g || w), ' ') as text
  from generate_series(1, ${DOC_KB} * 1024 / 33) w
) t;

insert into "Analysis" (id, "documentId", status, "overallRisk", "modelRisk", summary, "missingClauses", model,
                        "promptVersion", "inputTokens", "outputTokens", "durationMs", "createdAt", "completedAt")
select 'a' || g, 'd' || g, 'COMPLETED', 'HIGH', 'HIGH', repeat(md5(g::text), 12),
       array['deposit', 'kill_fee'], 'claude-sonnet-5', 'analyze-v6', 9000, 1500, 25000, now(), now()
from generate_series(1, ${DOCS}) g;

insert into "Finding" (id, "analysisId", category, severity, "clauseExcerpt", explanation, "suggestedChange")
select 'f' || a || '-' || k, 'a' || a, 'PAYMENT', 'HIGH',
       repeat(md5(a::text || k || random()), 8), repeat(md5(k || a::text), 12), repeat(md5(a::text), 6)
from generate_series(1, ${DOCS}) a, generate_series(1, ${FINDINGS_PER}) k;

insert into "AuditEvent" (id, "subjectHash", action, "requestId", "ipHash", "createdAt")
select 'e' || g, md5('s' || (g % ${USERS})), 'LOGIN_SUCCEEDED', md5(g::text), md5('ip' || g),
       now() - (g % 395) * interval '1 day'
from generate_series(1, ${AUDIT}) g;
analyze;
SQL
t1=$(now)
db_size="$(psql_in "$SRC" -c "select pg_size_pretty(pg_database_size('drill'))")"
echo "  seeded in $(secs "$t0" "$t1") s; database size ${db_size}"
# Sorted: UNION ALL does not promise an order, and a diff must compare data.
psql_in "$SRC" -c "$VERIFY_SQL" | sort >"$WORK/source.txt"
docker build -q -t "$IMAGE" server >/dev/null
# Redis holds rate-limit counters and nothing a restore brings back; it is
# here so the API can be judged ready by its own, whole /api/ready.
docker run -d --name "$REDIS" --network "$NET" redis:7-alpine >/dev/null
echo "  API image built; Redis running"

echo "== backup (pg_dump -Fc)"
t0=$(now)
docker exec "$SRC" pg_dump -U drill -d drill -Fc -f /tmp/drill.dump
docker cp "$SRC:/tmp/drill.dump" "$WORK/drill.dump" >/dev/null
t1=$(now)
dump_size="$(du -h "$WORK/drill.dump" | cut -f1)"
echo "  backup took $(secs "$t0" "$t1") s; dump ${dump_size}"

echo "== RTO clock starts"
rto0=$(now)

step0=$(now)
start_pg "$DST" 55502
step1=$(now)
echo "  1. new Postgres provisioned: $(secs "$step0" "$step1") s"

docker cp "$WORK/drill.dump" "$DST:/tmp/drill.dump" >/dev/null
docker exec "$DST" pg_restore -U drill -d drill --no-owner --exit-on-error -j 4 /tmp/drill.dump
step2=$(now)
echo "  2. pg_restore: $(secs "$step1" "$step2") s"

psql_in "$DST" -c "$VERIFY_SQL" | sort >"$WORK/restored.txt"
if ! diff -u "$WORK/source.txt" "$WORK/restored.txt"; then
  echo "  3. VERIFY FAILED: the restored data differs from the original" >&2
  exit 1
fi
status="$(cd server && DATABASE_URL=postgresql://drill:drill@127.0.0.1:55502/drill npx prisma migrate status 2>&1 | tail -1)"
[[ "$status" == *"up to date"* ]] || { echo "  3. VERIFY FAILED: prisma migrate status: $status" >&2; exit 1; }
step3=$(now)
echo "  3. verified: row counts and checksums identical; ${status}: $(secs "$step2" "$step3") s"
sed 's/^/       /' "$WORK/restored.txt"

docker run -d --name "$API" --network "$NET" -p 127.0.0.1:55503:3000 \
  -e NODE_ENV=development -e PORT=3000 \
  -e DATABASE_URL="postgresql://drill:drill@$DST:5432/drill" -e REDIS_URL="redis://$REDIS:6379" \
  -e LLM_PROVIDER=mock -e ANTHROPIC_API_KEY=drill-placeholder-not-a-key -e ANTHROPIC_MODEL=claude-sonnet-5 \
  -e JWT_SECRET=restore-drill-only-jwt-secret-32-bytes-min \
  -e AUDIT_SALT=restore-drill-only-audit-salt-32-bytes-min \
  -e FRONTEND_ORIGIN=http://127.0.0.1:4173 -e LLM_PRICE_INPUT_PER_MTOK=3 -e LLM_PRICE_OUTPUT_PER_MTOK=15 \
  -e MONTHLY_SPEND_CEILING_USD=100 -e EMAIL_SINK_DIR=/tmp/mail-sink -e LOG_LEVEL=warn \
  --read-only --tmpfs /tmp "$IMAGE" >/dev/null
code=""
for _ in $(seq 1 60); do
  code="$(curl -s -o "$WORK/ready.json" -w '%{http_code}' http://127.0.0.1:55503/api/ready || true)"
  [[ "$code" == 200 ]] && break
  sleep 0.5
done
step4=$(now)
if [[ "$code" != 200 ]]; then
  echo "  4. API FAILED to come up on the restored database: $code $(cat "$WORK/ready.json" 2>/dev/null)" >&2
  docker logs "$API" 2>&1 | tail -20 >&2
  exit 1
fi
echo "  4. API up on the restored database, /api/ready 200: $(secs "$step3" "$step4") s"
rto1=$(now)

echo "== RTO clock stops: $(secs "$rto0" "$rto1") s, against NFR-3.6's 4 h (14,400 s)"
echo "   database ${db_size}, dump ${dump_size}, ${USERS} users, ${DOCS} documents, $((DOCS * FINDINGS_PER)) findings, ${AUDIT} audit events"
