#!/usr/bin/env bash
# Phase 14: Hourly sweep — expire listings whose expires_at has passed
# Phase 15 will extend this block to also purge card photos for newly-expired listings
set -euo pipefail

ENV_FILE="$(dirname "$0")/../nextjs/.env.local"

# Load env vars if file exists
if [[ -f "$ENV_FILE" ]]; then
  # Export only the two keys we need (avoid loading everything into the environment)
  SUPABASE_URL="$(grep -m1 '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
  SERVICE_ROLE_KEY="$(grep -m1 '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE" | cut -d= -f2-)"
else
  SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
  SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
fi

if [[ -z "$SUPABASE_URL" || -z "$SERVICE_ROLE_KEY" ]]; then
  echo "[$(date -u +%H:%M:%S)] expire-listings: ERROR — missing SUPABASE_URL or SERVICE_ROLE_KEY" >&2
  exit 1
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# PATCH listings WHERE status='active' AND expires_at < now() → status='expired'
RESPONSE="$(curl -sS -w "\n%{http_code}" -X PATCH \
  "${SUPABASE_URL}/rest/v1/listings?status=eq.active&expires_at=lt.${NOW}" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation,count=exact" \
  -d '{"status":"expired"}')"

HTTP_CODE="$(echo "$RESPONSE" | tail -n1)"
BODY="$(echo "$RESPONSE" | head -n-1)"

# ---- Phase 15 extension point ----
# When card photos land, query the newly-expired listing ids from BODY and
# DELETE their storage objects + card_photos rows here, before this script exits.
# ----------------------------------

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
  COUNT="$(echo "$BODY" | grep -o '"id":' | wc -l | tr -d ' ')"
  echo "[$(date -u +%H:%M:%S)] expire-listings: ${COUNT} listing(s) expired (HTTP ${HTTP_CODE})"
else
  echo "[$(date -u +%H:%M:%S)] expire-listings: ERROR — HTTP ${HTTP_CODE}: ${BODY}" >&2
  exit 1
fi
