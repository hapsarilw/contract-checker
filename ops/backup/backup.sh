#!/bin/sh
# One backup: pg_dump -> check it reads -> encrypt with age -> upload to S3.
# Run nightly by Render's cron job (ops/render/*.render.yaml). The API's
# weekly backup-verify job lists the bucket (server/src/jobs/backupVerify.js)
# and pages if the newest dump is missing, old, tiny, or shrank.
#
# WHY ENCRYPTED: a dump holds every contract every user uploaded. age with
# the owner's PUBLIC key only: nothing that runs here can decrypt it, so a
# leaked bucket or a leaked writer key exposes nothing. The private key lives
# offline with the owner (docs/panduan-pemilik.md) and is needed only to
# restore (restore.sh).
#
# WHY A FILE FIRST, not one pipe to S3: a dump that fails halfway must not
# become an object in the bucket. The dump is written, read back
# (pg_restore --list fails on a truncated file), encrypted, and only then
# uploaded. A failure at any step exits non-zero, which Render records as a
# failed run, and no object is written.
#
# Environment (secrets come from Render's dashboard, never a file):
#   DATABASE_URL                 the database to dump
#   BACKUP_S3_BUCKET             where to put it
#   BACKUP_S3_REGION             the bucket's region
#   BACKUP_S3_PREFIX             optional key prefix, e.g. "production/"
#   BACKUP_S3_ENDPOINT           optional, a non-AWS S3 (MinIO in the drill)
#   BACKUP_S3_ACCESS_KEY_ID      the WRITER key: s3:PutObject on the bucket
#   BACKUP_S3_SECRET_ACCESS_KEY  and nothing else
#   BACKUP_AGE_RECIPIENT         the age public key (age1...)
#
# Never printed: the database URL, the keys, the dump's contents.
set -eu

need() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "backup: $1 is not set" >&2
    exit 2
  fi
}
for name in DATABASE_URL BACKUP_S3_BUCKET BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY_ID \
  BACKUP_S3_SECRET_ACCESS_KEY BACKUP_AGE_RECIPIENT; do
  need "$name"
done
case "$BACKUP_AGE_RECIPIENT" in
  age1*) ;;
  *) echo "backup: BACKUP_AGE_RECIPIENT is not an age public key (age1...)" >&2; exit 2 ;;
esac

export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="$BACKUP_S3_REGION"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
key="${BACKUP_S3_PREFIX:-}${stamp}.dump.age"
started="$(date +%s)"

# --no-owner / --no-privileges: restorable into a database with other role
# names (a scratch database, another provider), which is the point.
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$work/db.dump"
pg_restore --list "$work/db.dump" > "$work/toc"
tables="$(grep -c " TABLE DATA " "$work/toc" || true)"

age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$work/db.dump.age" "$work/db.dump"
rm -f "$work/db.dump"
bytes="$(wc -c < "$work/db.dump.age" | tr -d ' ')"

if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  aws s3 cp "$work/db.dump.age" "s3://$BACKUP_S3_BUCKET/$key" --only-show-errors --endpoint-url "$BACKUP_S3_ENDPOINT"
else
  aws s3 cp "$work/db.dump.age" "s3://$BACKUP_S3_BUCKET/$key" --only-show-errors
fi

echo "backup: uploaded ${stamp}.dump.age, ${bytes} bytes encrypted, ${tables} tables with data, $(( $(date +%s) - started )) s"
