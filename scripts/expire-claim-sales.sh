#!/usr/bin/env bash
# scripts/expire-claim-sales.sh — Zero-token sweep: expire past-due claim sales + purge their follows
# Runs hourly via cron. No model tokens consumed.
# Requires: Supabase service-role key in dbb/nextjs/.env.local (sourced at runtime)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../nextjs/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[$(date -u +%H:%M:%S)] expire-claim-sales: env file not found at $ENV_FILE"
  exit 1
fi

# Source env vars
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:?NEXT_PUBLIC_SUPABASE_URL not set}"
SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY not set}"

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
AUTH_HEADERS=(-H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY")

# 1. Expire claim sales past their expires_at
EXPIRE_RESPONSE="$(curl -s -w "\n%{http_code}" \
  -X PATCH \
  "${AUTH_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d '{"status":"expired"}' \
  "${SUPABASE_URL}/rest/v1/claim_sales?status=eq.active&expires_at=lt.${NOW_ISO}&select=id")"

EXPIRE_HTTP="$(echo "$EXPIRE_RESPONSE" | tail -n1)"
EXPIRE_BODY="$(echo "$EXPIRE_RESPONSE" | head -n-1)"

if [[ "$EXPIRE_HTTP" -ge 200 && "$EXPIRE_HTTP" -lt 300 ]]; then
  # Extract expired claim sale IDs from the response body
  EXPIRED_IDS="$(echo "$EXPIRE_BODY" | { grep -o '"id":"[^"]*"' || true; } | sed 's/"id":"//;s/"//' | tr '\n' ',' | sed 's/,$//')"
  EXPIRED_COUNT="$(echo "$EXPIRE_BODY" | { grep -o '"id":"[^"]*"' || true; } | wc -l | tr -d ' ')"
  echo "[$(date -u +%H:%M:%S)] expire-claim-sales: ${EXPIRED_COUNT} claim sale(s) expired (HTTP ${EXPIRE_HTTP})"

  if [[ -z "$EXPIRED_IDS" ]]; then
    echo "[$(date -u +%H:%M:%S)] expire-claim-sales: no expired sales to clean up follows/listings for"
    exit 0
  fi

  # 2. Purge follows for expired claim sales (using in. filter with comma-separated IDs)
  FOLLOW_RESPONSE="$(curl -s -w "\n%{http_code}" \
    -X DELETE \
    "${AUTH_HEADERS[@]}" \
    -H "Prefer: return=minimal" \
    "${SUPABASE_URL}/rest/v1/follows?claim_sale_id=in.(${EXPIRED_IDS})")"

  FOLLOW_HTTP="$(echo "$FOLLOW_RESPONSE" | tail -n1)"

  if [[ "$FOLLOW_HTTP" -ge 200 && "$FOLLOW_HTTP" -lt 300 ]]; then
    echo "[$(date -u +%H:%M:%S)] expire-claim-sales: follows purged for ${EXPIRED_COUNT} sale(s) (HTTP ${FOLLOW_HTTP})"
  else
    echo "[$(date -u +%H:%M:%S)] expire-claim-sales: follow purge failed (HTTP ${FOLLOW_HTTP})"
    echo "$FOLLOW_RESPONSE" | head -n-1
  fi

  # 3. Expire listings linked to expired claim sales
  LISTING_RESPONSE="$(curl -s -w "\n%{http_code}" \
    -X PATCH \
    "${AUTH_HEADERS[@]}" \
    -H "Content-Type: application/json" \
    -d '{"status":"expired"}' \
    "${SUPABASE_URL}/rest/v1/listings?claim_sale_id=in.(${EXPIRED_IDS})&status=eq.active")"

  LISTING_HTTP="$(echo "$LISTING_RESPONSE" | tail -n1)"

  if [[ "$LISTING_HTTP" -ge 200 && "$LISTING_HTTP" -lt 300 ]]; then
    echo "[$(date -u +%H:%M:%S)] expire-claim-sales: linked listings expired (HTTP ${LISTING_HTTP})"
  else
    echo "[$(date -u +%H:%M:%S)] expire-claim-sales: listing expiry failed (HTTP ${LISTING_HTTP})"
    echo "$LISTING_RESPONSE" | head -n-1
  fi
else
  echo "[$(date -u +%H:%M:%S)] expire-claim-sales: PATCH failed (HTTP ${EXPIRE_HTTP})"
  echo "$EXPIRE_BODY"
fi