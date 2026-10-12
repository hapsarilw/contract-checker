# The nightly database backup (BUILD-PLAN step 75; the owner's decision of
# 2026-10-12: S3, destroyed within 30 days, encrypted with age). Run by Render as a cron
# job (ops/render/*.render.yaml); see backup.sh for what it does.
#
# postgres:15, the major version the Blueprints provision: pg_dump must be
# at least the server's version, and the same major is the safe choice.
FROM postgres:15-alpine
RUN apk add --no-cache age aws-cli
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh
# Not root: nothing here needs it.
USER postgres
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/backup.sh"]
