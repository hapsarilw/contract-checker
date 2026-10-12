#!/bin/sh
# Restore one backup made by backup.sh into a database: download -> decrypt
# with the owner's PRIVATE age key -> pg_restore. For the database-restore
# runbook and the backup drill. Into a SCRATCH database first, always: the
# runbook says when (and whether) to point production at it.
#
#   restore.sh <object key, or "latest">
#
# Environment: BACKUP_S3_BUCKET, BACKUP_S3_REGION, BACKUP_S3_PREFIX (opt),
# BACKUP_S3_ENDPOINT (opt), BACKUP_S3_ACCESS_KEY_ID and
# BACKUP_S3_SECRET_ACCESS_KEY (a key that can READ the bucket; the writer
# key cannot), BACKUP_AGE_IDENTITY_FILE (the private key, as a file, never
# an environment variable), TARGET_DATABASE_URL (the database to restore
# into; it should be empty).
set -eu

which="${1:?usage: restore.sh <object key | latest>}"
for name in BACKUP_S3_BUCKET BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY \
  BACKUP_AGE_IDENTITY_FILE TARGET_DATABASE_URL; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || { echo "restore: $name is not set" >&2; exit 2; }
done
[ -r "$BACKUP_AGE_IDENTITY_FILE" ] || { echo "restore: cannot read BACKUP_AGE_IDENTITY_FILE" >&2; exit 2; }

export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="$BACKUP_S3_REGION"
endpoint=""
[ -n "${BACKUP_S3_ENDPOINT:-}" ] && endpoint="--endpoint-url $BACKUP_S3_ENDPOINT"

if [ "$which" = "latest" ]; then
  # Keys are ISO timestamps, so the last in order is the newest. The
  # backticks are JMESPath's literal syntax, not a shell expansion (SC2016).
  # shellcheck disable=SC2086,SC2016
  which="$(aws s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "${BACKUP_S3_PREFIX:-}" \
    --query 'Contents[?ends_with(Key, `.dump.age`)].Key' --output text $endpoint | tr '\t' '\n' | sort | tail -n 1)"
  [ -n "$which" ] && [ "$which" != "None" ] || { echo "restore: no backups in the bucket" >&2; exit 1; }
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
started="$(date +%s)"
# shellcheck disable=SC2086
aws s3 cp "s3://$BACKUP_S3_BUCKET/$which" "$work/db.dump.age" --only-show-errors $endpoint
age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$work/db.dump" "$work/db.dump.age"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET_DATABASE_URL" "$work/db.dump"
echo "restore: ${which} restored in $(( $(date +%s) - started )) s"
