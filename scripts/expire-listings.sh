#!/usr/bin/env bash
# Phase 14: Hourly sweep — expire listings whose expires_at has passed
# Phase 15: Also purge card photos for newly-expired listings (self-destruct guarantee)
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
BODY="$(echo "$RESPONSE" | sed '$d')"

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
  # `|| true`: grep exits 1 on zero matches (no expired rows — the normal case);
  # without it, pipefail + set -e abort the whole sweep with a bogus failure.
  COUNT="$(echo "$BODY" | { grep -o '"library_card_id":"[^"]*"' || true; } | wc -l | tr -d ' ')"
  echo "[$(date -u +%H:%M:%S)] expire-listings: ${COUNT} listing(s) expired (HTTP ${HTTP_CODE})"

  # ---- Phase 18: Photo self-destruct REMOVED ----
  # Photos belong to the library CARD, not the listing. They persist through
  # listing expiry and relisting. Photos are only deleted when:
  #   1. The owner explicitly retakes/removes the photo
  #   2. The library card itself is deleted (CASCADE)
  # ---- End Phase 18 change ----

elif echo "$BODY" | grep -q '"42703"'; then
  # migration-009 not applied yet — no expires_at column, nothing to sweep
  echo "[$(date -u +%H:%M:%S)] expire-listings: skipped (migration-009 pending)"
else
  echo "[$(date -u +%H:%M:%S)] expire-listings: ERROR — HTTP ${HTTP_CODE}: ${BODY}" >&2
  exit 1
fi
