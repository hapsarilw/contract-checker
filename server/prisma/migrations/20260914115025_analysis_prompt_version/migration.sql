-- Appendix A / FR-3.5 — record which prompt revision produced each analysis.
--
-- Expand only (§5.5, docs/migrations.md): a new nullable column with no
-- default. On Postgres 15 that is a catalog-only change — no table rewrite,
-- no scan — so its ACCESS EXCLUSIVE lock is held only momentarily, and the
-- previous application version keeps running against the new shape. Rows
-- written before this migration have no version and stay NULL; there is
-- nothing to backfill them from.
ALTER TABLE "Analysis" ADD COLUMN "promptVersion" TEXT;
