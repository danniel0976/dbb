#!/usr/bin/env bash
#
# DBB Deploy Smoke Test — zero provider tokens, just curl.
#
# Curls key DBB endpoints on Vercel after deploy, checks HTTP 200 or expected
# redirects, writes a flag file on failure, exits 0 on success / non-zero on fail.
#
# Usage:
#   ./scripts/deploy-smoke.sh                     # test production
#   BASE_URL=http://localhost:3000 ./scripts/deploy-smoke.sh  # test local
#
# Output: parseable TSV-like lines to stdout, JSON artifact to test-runs/.
#
set -euo pipefail

BASE_URL="${BASE_URL:-https://dbb.lovelikenotomorrow.com}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="$REPO_DIR/test-runs"
mkdir -p "$RUN_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COMMIT="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
FAIL_FLAG="/tmp/dbb-smoke-fail"
ARTIFACT="$RUN_DIR/${TIMESTAMP}.smoke.json"

# Routes: path|expected_status (200 or 3xx for redirect)
ROUTES=(
  "/|200"
  "/library|200"
  "/bazaar|200"
  "/claim-sales|200"
  "/import|200"
  "/profile|200"
  "/cart|200"
  "/login|200"
  "/register|200"
)

# Clear any previous fail flag
rm -f "$FAIL_FLAG"

# curl timing format (in ms)
CURL_FMT='%{http_code} %{time_total} %{url_effective}'

pass_count=0
fail_count=0
results=""

echo "=== DBB Deploy Smoke Test ==="
echo "BASE_URL: $BASE_URL"
echo "COMMIT:  $COMMIT"
echo "TIME:    $TIMESTAMP"
echo ""

for entry in "${ROUTES[@]}"; do
  path="${entry%%|*}"
  expected="${entry##*|}"
  url="${BASE_URL}${path}"

  # Follow redirects but capture final status; -o /dev/null to discard body
  raw=$(curl -sS -o /dev/null -w "$CURL_FMT" -L --max-time 15 "$url" 2>/dev/null || true)
  status=$(echo "$raw" | awk '{print $1}')
  time_s=$(echo "$raw" | awk '{print $2}')

  # Handle curl failure (empty output)
  if [ -z "$status" ] || [ "$status" = "000" ]; then
    status="000"
    time_s="0.000"
  fi

  # Check: 200 for expected 200; 200 or 3xx for redirects (we use -L so final should be 200)
  if [ "$expected" = "200" ]; then
    if [ "$status" = "200" ]; then
      verdict="PASS"
    else
      verdict="FAIL"
    fi
  else
    # For redirect-expected routes, -L follows so final 200 is fine, or 3xx if no follow
    if [ "$status" = "200" ] || [[ "$status" =~ ^3 ]]; then
      verdict="PASS"
    else
      verdict="FAIL"
    fi
  fi

  time_ms=$(awk "BEGIN { printf \"%.0f\", ${time_s:-0} * 1000 }")

  printf "%-12s  expected=%-3s  got=%-3s  %5sms  %s\n" "$path" "$expected" "$status" "$time_ms" "$verdict"

  results="${results}{\"path\":\"$path\",\"expected\":$expected,\"status\":$status,\"time_ms\":$time_ms,\"verdict\":\"$verdict\"},"

  if [ "$verdict" = "PASS" ]; then
    pass_count=$((pass_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi
done

# Strip trailing comma
results="${results%,}"

total=$((pass_count + fail_count))
overall="PASS"
if [ "$fail_count" -gt 0 ]; then
  overall="FAIL"
  touch "$FAIL_FLAG"
fi

echo ""
echo "Result: $pass_count/$total passed, $fail_count failed → $overall"

# Write JSON artifact
cat > "$ARTIFACT" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "commit": "$COMMIT",
  "base_url": "$BASE_URL",
  "overall": "$overall",
  "pass_count": $pass_count,
  "fail_count": $fail_count,
  "total": $total,
  "routes": [$results]
}
EOF

echo "Artifact: $ARTIFACT"

if [ "$fail_count" -gt 0 ]; then
  exit 1
else
  exit 0
fi