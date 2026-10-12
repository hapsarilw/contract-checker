# Database backups

The nightly backup and the tools to check and restore it (BUILD-PLAN step
75; the owner's decisions of 2026-10-12: Amazon S3, encrypted with `age`,
destroyed within 30 days).

| File | What it is |
|---|---|
| `Dockerfile` | The image Render runs as a cron job: Postgres 15's `pg_dump`, `age` and the AWS CLI |
| `backup.sh` | One backup: dump, read it back, encrypt with the owner's PUBLIC key, upload |
| `restore.sh` | One restore: download, decrypt with the PRIVATE key, `pg_restore` into an empty database |
| `policy-writer.json` | IAM policy for the cron job's key: `s3:PutObject` only |
| `policy-lister.json` | IAM policy for the API's key: `s3:ListBucket` only |
| `policy-restorer.json` | IAM policy for a person restoring: list and download, no write |
| `lifecycle.json` | The bucket's lifecycle rule: expire after 29 days |
| `drill.sh` | All of the above end to end, against MinIO, with the same policies |

**Why 29 days in the rule.** PRD §12.4, the privacy policy and the terms all
publish one promise: a deleted account or document survives in backups for
at most 30 days. S3 removes expired objects asynchronously, typically within
a day of the expiry date, so the rule expires them a day early and the
promise holds.

**Why encrypted.** A dump holds every contract every user uploaded. Nothing
that runs on Render can decrypt one: the cron job has only the public key.
The private key lives offline with the owner and is needed only to restore.

**What checks it.** The API's weekly `backup-verify` job lists the bucket
(`server/src/jobs/backupVerify.js`) and pages (`backup_verify_failed`) if the
newest dump is missing, older than 36 hours, smaller than an empty
database's dump, or less than half the size of the one before it. It cannot
tell a valid dump from a corrupt one of the same size: only a restore can,
which is what `drill.sh` and the `database-restore` runbook do.

Setting it up is the owner's: `docs/panduan-pemilik.md`, section D2.
