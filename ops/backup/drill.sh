#!/usr/bin/env bash
# The backup path end to end, on this machine (BUILD-PLAN step 75; the
# owner's decisions of 2026-10-12: S3, 30 days, age). Everything the nightly
# Render cron job and the weekly check will do, against MinIO standing in
# for S3, with the SAME IAM policies the owner will attach in AWS:
#
#   1. a Postgres, migrated and filled with synthetic data;
#   2. MinIO with a bucket and three users, one per policy file here:
#      writer (the cron job), lister (the API), restorer (a person);
#   3. the policies hold: the writer cannot list or read, the lister
#      cannot read or write, the restorer cannot write;
#   4. backup.sh, from the image Render will run, as the writer;
#   5. the object is encrypted: not a readable dump, no document text;
#   6. the API's own backup-verify source (listBackupsInS3) and check
#      (assessBackups), as the lister: newest, age, size;
#   7. restore.sh, as the restorer, with the private age key, into an
#      empty Postgres; every table's count and a checksum of every
#      document's text and every finding's excerpt compared;
#   8. the size of a dump of an EMPTY database, which is what
#      BACKUP_MIN_BYTES's floor has to sit above.
#
#   ops/backup/drill.sh
#   DRILL_DOCS=200 ops/backup/drill.sh    # smaller
#
# Synthetic data only. Nothing is shared with a development database, and
# nothing is left behind. Output goes to $BACKUP_DRILL_DIR when set.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DOCS="${DRILL_DOCS:-2000}"
USERS=$(( DOCS / 4 + 1 ))
TAG="$$"
NET="backup-drill-$TAG"
SRC="backup-drill-src-$TAG"
EMPTY="backup-drill-empty-$TAG"
DST="backup-drill-dst-$TAG"
S3="backup-drill-s3-$TAG"
IMAGE="clausecheck-backup:drill"
PG_IMAGE="postgres:15-alpine"
# MinIO's own images are no longer public on Docker Hub (checked 2026-10-12:
# the repository is gone); Bitnami's legacy mirror still carries them.
MINIO_IMAGE="bitnamilegacy/minio:2025.7.23-debian-12-r5"
MC_IMAGE="bitnamilegacy/minio-client:2025.7.21-debian-12-r3"
BUCKET="clausecheck-backups-drill"
ROOT_USER="drill-root"
ROOT_PASS="drill-root-password-not-a-secret"
WORK="$(mktemp -d)"
OUT="${BACKUP_DRILL_DIR:-$WORK}"
mkdir -p "$OUT"

cleanup() {
  docker rm -f "$SRC" "$EMPTY" "$DST" "$S3" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0
fail=0
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@"; then echo "  PASS  $name"; pass=$((pass + 1)); else echo "  FAIL  $name"; fail=$((fail + 1)); fi
}
refused() { ! "$@" >/dev/null 2>&1; }

psql_in() { docker exec -i "$1" psql -U drill -d drill -v ON_ERROR_STOP=1 -tA "${@:2}"; }
start_pg() { # start_pg <name> <host port>
  docker run -d --name "$1" --network "$NET" -e POSTGRES_USER=drill -e POSTGRES_PASSWORD=drill \
    -e POSTGRES_DB=drill -p "127.0.0.1:$2:5432" "$PG_IMAGE" >/dev/null
  for _ in $(seq 1 120); do psql_in "$1" -c "select 1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  return 1
}
mc() { docker run --rm --network "$NET" -e MC_HOST_s3="http://$ROOT_USER:$ROOT_PASS@$S3:9000" --entrypoint mc "$MC_IMAGE" "$@"; }
# The backup image, as one of the three users. Never root's keys.
as_user() { # as_user <access key> <secret> <command...>
  local key="$1" secret="$2"; shift 2
  docker run --rm --network "$NET" -v "$WORK:/work" \
    -e BACKUP_S3_BUCKET="$BUCKET" -e BACKUP_S3_REGION=us-east-1 -e BACKUP_S3_ENDPOINT="http://$S3:9000" \
    -e BACKUP_S3_ACCESS_KEY_ID="$key" -e BACKUP_S3_SECRET_ACCESS_KEY="$secret" \
    -e AWS_ACCESS_KEY_ID="$key" -e AWS_SECRET_ACCESS_KEY="$secret" -e AWS_DEFAULT_REGION=us-east-1 \
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} --entrypoint "$1" "$IMAGE" "${@:2}"
}

VERIFY_SQL='
select '"'"'User'"'"', count(*)::text from "User"
union all select '"'"'Document'"'"', count(*)::text from "Document"
union all select '"'"'Analysis'"'"', count(*)::text from "Analysis"
union all select '"'"'Finding'"'"', count(*)::text from "Finding"
union all select '"'"'Document.rawText md5'"'"', md5(string_agg(md5("rawText"), '"''"' order by id)) from "Document"
union all select '"'"'Finding.clauseExcerpt md5'"'"', md5(string_agg(md5("clauseExcerpt"), '"''"' order by id)) from "Finding";'

echo "== setup: ${DOCS} synthetic documents, MinIO, three users, the backup image"
docker network create "$NET" >/dev/null
start_pg "$SRC" 55511
start_pg "$EMPTY" 55512
for port in 55511 55512; do
  (cd server && DATABASE_URL="postgresql://drill:drill@127.0.0.1:$port/drill" npx prisma migrate deploy >/dev/null)
done
psql_in "$SRC" >/dev/null <<SQL
insert into "User" (id, email, "passwordHash", state, "emailVerifiedAt", "updatedAt")
select 'u' || g, 'drill-' || g || '@drill.invalid', 'x', 'ACTIVE', now(), now()
from generate_series(1, ${USERS}) g;
insert into "Document" (id, "userId", filename, "sourceType", "rawText", "textSha256", "wordCount", "byteSize", "createdAt")
select 'd' || g, 'u' || (1 + g % ${USERS}), 'contract-' || g || '.pdf', 'UPLOAD_PDF',
       'DRILLMARKER ' || t.text, md5(t.text), 700, length(t.text), now()
from generate_series(1, ${DOCS}) g
cross join lateral (select string_agg(md5(random()::text || g || w), ' ') as text from generate_series(1, 200) w) t;
insert into "Analysis" (id, "documentId", status, "overallRisk", "modelRisk", summary, "missingClauses", model,
                        "promptVersion", "inputTokens", "outputTokens", "durationMs", "createdAt", "completedAt")
select 'a' || g, 'd' || g, 'COMPLETED', 'HIGH', 'HIGH', md5(g::text), array['deposit'], 'claude-sonnet-5',
       'analyze-v6', 9000, 1500, 25000, now(), now()
from generate_series(1, ${DOCS}) g;
insert into "Finding" (id, "analysisId", category, severity, "clauseExcerpt", explanation, "suggestedChange")
select 'f' || a || '-' || k, 'a' || a, 'PAYMENT', 'HIGH', repeat(md5(a::text || k), 4), md5(k::text), md5(a::text)
from generate_series(1, ${DOCS}) a, generate_series(1, 4) k;
analyze;
SQL
psql_in "$SRC" -c "$VERIFY_SQL" | sort >"$WORK/source.txt"

docker run -d --name "$S3" --network "$NET" -p 127.0.0.1:55514:9000 -e MINIO_ROOT_USER="$ROOT_USER" -e MINIO_ROOT_PASSWORD="$ROOT_PASS" \
  --entrypoint minio "$MINIO_IMAGE" server /tmp/data >/dev/null
for _ in $(seq 1 60); do mc ready s3 >/dev/null 2>&1 && break; sleep 1; done
mc mb "s3/$BUCKET" >/dev/null
# The same three policy files the owner attaches in AWS, bucket name filled in.
for role in writer lister restorer; do
  sed "s/BUCKET_NAME/$BUCKET/g" "ops/backup/policy-$role.json" >"$WORK/policy-$role.json"
done
docker run --rm --network "$NET" -v "$WORK:/work" -e MC_HOST_s3="http://$ROOT_USER:$ROOT_PASS@$S3:9000" \
  --entrypoint sh "$MC_IMAGE" -c '
    set -e
    for role in writer lister restorer; do
      mc admin user add s3 "drill-$role" "drill-$role-secret-not-a-secret" >/dev/null
      mc admin policy create s3 "drill-$role" "/work/policy-$role.json" >/dev/null
      mc admin policy attach s3 "drill-$role" --user "drill-$role" >/dev/null
    done'
docker build -q -t "$IMAGE" ops/backup >/dev/null
# A throwaway key pair, as the owner will make with age-keygen.
docker run --rm --entrypoint age-keygen "$IMAGE" 2>/dev/null >"$WORK/identity.txt"
chmod 600 "$WORK/identity.txt"
RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$WORK/identity.txt" | head -n 1)"
W=(drill-writer drill-writer-secret-not-a-secret)
L=(drill-lister drill-lister-secret-not-a-secret)
R=(drill-restorer drill-restorer-secret-not-a-secret)
EXTRA_ENV=(-e "BACKUP_AGE_RECIPIENT=$RECIPIENT")

echo "== backup.sh as the writer"
t0=$(date +%s)
EXTRA_ENV+=(-e "DATABASE_URL=postgresql://drill:drill@$SRC:5432/drill" -e "BACKUP_S3_PREFIX=drill/")
as_user "${W[@]}" /usr/local/bin/backup.sh | tee "$OUT/backup.log"
t1=$(date +%s)
# The empty database's dump: the smallest a real backup can ever be.
EXTRA_ENV=(-e "BACKUP_AGE_RECIPIENT=$RECIPIENT" -e "DATABASE_URL=postgresql://drill:drill@$EMPTY:5432/drill" \
  -e "BACKUP_S3_PREFIX=empty/")
as_user "${W[@]}" /usr/local/bin/backup.sh | tee -a "$OUT/backup.log"
EXTRA_ENV=()
echo "  backup took $((t1 - t0)) s"

echo "== the policies hold"
check "the writer cannot list the bucket" refused as_user "${W[@]}" aws s3 ls "s3://$BUCKET/" --endpoint-url "http://$S3:9000"
key="$(mc ls --recursive --json "s3/$BUCKET/drill/" | grep -o '"key":"[^"]*dump.age"' | head -n 1 | cut -d'"' -f4)"
key="drill/$key"
echo "  the backup: $key"
check "the writer cannot read a backup" refused as_user "${W[@]}" aws s3 cp "s3://$BUCKET/$key" /tmp/x --endpoint-url "http://$S3:9000"
check "the lister can list" as_user "${L[@]}" aws s3 ls "s3://$BUCKET/" --endpoint-url "http://$S3:9000"
check "the lister cannot read a backup" refused as_user "${L[@]}" aws s3 cp "s3://$BUCKET/$key" /tmp/x --endpoint-url "http://$S3:9000"
check "the lister cannot write" refused as_user "${L[@]}" sh -c "echo x | aws s3 cp - s3://$BUCKET/planted.dump.age --endpoint-url http://$S3:9000"
check "the restorer cannot write" refused as_user "${R[@]}" sh -c "echo x | aws s3 cp - s3://$BUCKET/planted.dump.age --endpoint-url http://$S3:9000"

echo "== the object is encrypted"
docker run --rm --network "$NET" -v "$WORK:/work" -e MC_HOST_s3="http://$ROOT_USER:$ROOT_PASS@$S3:9000" \
    --entrypoint mc "$MC_IMAGE" cp "s3/$BUCKET/$key" /work/object.age >/dev/null
check "it starts with the age header" grep -q "age-encryption.org" "$WORK/object.age"
check "no document text in it" refused grep -q "DRILLMARKER" "$WORK/object.age"
check "pg_restore cannot read it as it is" refused docker run --rm -v "$WORK:/work" --entrypoint pg_restore "$PG_IMAGE" --list /work/object.age

echo "== the API's own check, as the lister (listBackupsInS3 + assessBackups)"
listing="$(cd server && env NODE_ENV=development DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused \
  REDIS_URL=redis://127.0.0.1:1 LLM_PROVIDER=mock ANTHROPIC_API_KEY=drill-placeholder-not-a-key \
  ANTHROPIC_MODEL=claude-sonnet-5 JWT_SECRET=backup-drill-only-jwt-secret-32-bytes-minimum \
  AUDIT_SALT=backup-drill-only-audit-salt-32-bytes-minimum FRONTEND_ORIGIN=http://127.0.0.1:4173 \
  LLM_PRICE_INPUT_PER_MTOK=3 LLM_PRICE_OUTPUT_PER_MTOK=15 MONTHLY_SPEND_CEILING_USD=100 LOG_LEVEL=silent \
  node --input-type=module -e "
    const { listBackupsInS3, assessBackups, s3Lister } = await import('./src/jobs/backupVerify.js');
    const port = process.argv[1];
    const list = s3Lister({ region: 'us-east-1', endpoint: 'http://127.0.0.1:' + port,
      accessKeyId: 'drill-lister', secretAccessKey: 'drill-lister-secret-not-a-secret' });
    const all = await listBackupsInS3({ bucket: '$BUCKET', list });
    const drill = await listBackupsInS3({ bucket: '$BUCKET', prefix: 'drill/', list });
    const empty = await listBackupsInS3({ bucket: '$BUCKET', prefix: 'empty/', list });
    const result = assessBackups(drill, new Date(), { minBytes: 1048576, maxAgeHours: 36 });
    console.log(JSON.stringify({ objects: all.length, dumpBytes: drill[0]?.sizeBytes, emptyDumpBytes: empty[0]?.sizeBytes, result }));
    process.exit(0);
  " 55514)" || true
echo "  $listing"
check "the check lists both dumps and passes" grep -q '"objects":2' <<<"$listing"
check "assessBackups: ok" grep -q '"ok":true' <<<"$listing"
echo "$listing" >"$OUT/listing.json"

echo "== restore.sh as the restorer, into an empty Postgres"
start_pg "$DST" 55513
r0=$(date +%s)
cp "$WORK/identity.txt" "$WORK/identity-for-restore.txt"
chmod 644 "$WORK/identity-for-restore.txt"
EXTRA_ENV=(-e "BACKUP_AGE_IDENTITY_FILE=/work/identity-for-restore.txt" \
  -e "TARGET_DATABASE_URL=postgresql://drill:drill@$DST:5432/drill")
as_user "${R[@]}" /usr/local/bin/restore.sh "$key" | tee "$OUT/restore.log"
EXTRA_ENV=()
r1=$(date +%s)
psql_in "$DST" -c "$VERIFY_SQL" | sort >"$WORK/restored.txt"
check "row counts and checksums identical to the source" diff -u "$WORK/source.txt" "$WORK/restored.txt"
sed 's/^/       /' "$WORK/restored.txt"
echo "  restore took $((r1 - r0)) s"

echo
echo "== summary: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
