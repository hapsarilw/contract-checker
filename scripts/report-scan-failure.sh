#!/usr/bin/env bash
# BUILD-PLAN step 70/71: how a failed weekly scan (.github/workflows/scan.yml)
# reaches the maintainer. Decided in step 71 (docs/deployment.md,
# "Decisions made"): one open GitHub issue, labelled with the alert's own
# name, that every later failure comments on until someone closes it.
#
#   scripts/report-scan-failure.sh <run url> <job>=<result>...
#
# Why an issue: it is the one channel that needs no provider account, keeps
# a timestamp to count SRS §2.1's seven days from, and records what was done
# when it is closed (the runbook's own "Record:" step). GitHub's failed-run
# email still arrives too; this is the durable half.
#
# What it deliberately does NOT say: which package or advisory. The
# repository is public. That list is computable from the public lockfile by
# anyone, but an issue titled with it is a signpost to an unpatched, deployed
# weakness; the run link carries the details for whoever can act on them.
# And a failed SECRET scan never comes here at all (scan.yml leaves that job
# out): a public issue pointing at a leaked credential before it has been
# rotated would be worse than silence. That one is the email, and
# docs/runbooks/secret-rotation.md.
#
# Needs `gh` and GH_TOKEN with issues:write (scan.yml's GITHUB_TOKEN).

set -euo pipefail

run_url="${1:?run url}"
shift
LABEL="dependency_critical_vuln"

failed=()
for pair in "$@"; do
  [[ "${pair#*=}" == "failure" ]] && failed+=("${pair%%=*}")
done
if [[ "${#failed[@]}" == 0 ]]; then
  echo "no failed scan job among: $*"
  exit 0
fi

now="$(node -e 'process.stdout.write(new Date().toISOString().slice(0, 10))')"
deadline="$(node -e 'process.stdout.write(new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10))')"
# read -d '', not $(cat <<...): bash mis-parses an apostrophe inside a
# heredoc inside a command substitution, and this body has one.
read -r -d '' body <<BODY || true
The weekly vulnerability scan failed on ${now}: **${failed[*]}**.

- Run (the findings are in its log): ${run_url}
- Procedure: [docs/runbooks/dependency-critical-vuln.md](../blob/main/docs/runbooks/dependency-critical-vuln.md)
- SRS §2.1: a known-exploitable critical is patched, or the dependency removed, within 7 days of the first report — **by ${deadline}** if this is the first comment on this issue.

Close this issue with what was done (the package, the advisory, reachable or not and why, the fix), which is the runbook's record.
BODY

gh label create "$LABEL" --color B60205 \
  --description "A scan found a known-exploitable critical (ops/alerts/ci-alerts.yml)" --force >/dev/null

existing="$(gh issue list --label "$LABEL" --state open --json number --jq '.[0].number // empty')"
if [[ -n "$existing" ]]; then
  gh issue comment "$existing" --body "$body"
  echo "commented on the open issue #$existing"
else
  gh issue create --title "Weekly vulnerability scan failed" --label "$LABEL" --body "$body"
fi
