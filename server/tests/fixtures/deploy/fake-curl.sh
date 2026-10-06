#!/usr/bin/env bash
# A stand-in for curl in scripts/deploy/platform.sh's tests: records every
# call, answers a POST with a deploy id, and answers each GET with the next
# state from FAKE_STATES (comma-separated; the last one repeats), under the
# key FAKE_KEY ("status" for Render, "state" for Netlify).
echo "$*" >>"$FAKE_CURL_LOG"
if [[ " $* " == *" -X POST "* ]]; then
  echo '{"id":"dep-1"}'
  exit 0
fi
n="$(cat "$FAKE_CURL_COUNTER" 2>/dev/null || echo 0)"
echo $((n + 1)) >"$FAKE_CURL_COUNTER"
IFS=, read -ra states <<<"$FAKE_STATES"
last=$((${#states[@]} - 1))
i=$((n < last ? n : last))
printf '{"%s":"%s"}\n' "${FAKE_KEY:-status}" "${states[$i]}"
