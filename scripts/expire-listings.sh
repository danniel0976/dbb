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
BODY="$(echo "$RESPONSE" | head -n-1)"

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
  COUNT="$(echo "$BODY" | grep -o '"library_card_id":"[^"]*"' | wc -l | tr -d ' ')"
  echo "[$(date -u +%H:%M:%S)] expire-listings: ${COUNT} listing(s) expired (HTTP ${HTTP_CODE})"

  # ---- Phase 15: Self-destruct card photos for newly-expired listings ----
  # Extract library_card_ids from the expired listings response
  LIBRARY_CARD_IDS="$(echo "$BODY" | grep -oP '"library_card_id":"\K[^"]*' 2>/dev/null || true)"

  if [[ -n "$LIBRARY_CARD_IDS" ]]; then
    PHOTO_COUNT=0
    while IFS= read -r LC_ID; do
      [[ -z "$LC_ID" ]] && continue

      # Get the storage_path for this library_card_id from card_photos
      PHOTO_RESP="$(curl -sS -w "\n%{http_code}" \
        "${SUPABASE_URL}/rest/v1/card_photos?library_card_id=eq.${LC_ID}&select=storage_path" \
        -H "apikey: ${SERVICE_ROLE_KEY}" \
        -H "Authorization: Bearer ${SERVICE_ROLE_KEY}")"

      PHOTO_HTTP="$(echo "$PHOTO_RESP" | tail -n1)"
      PHOTO_BODY="$(echo "$PHOTO_RESP" | head -n-1)"

      if [[ "$PHOTO_HTTP" -ge 200 && "$PHOTO_HTTP" -lt 300 ]]; then
        STORAGE_PATH="$(echo "$PHOTO_BODY" | grep -oP '"storage_path":"\K[^"]*' 2>/dev/null || true)"

        if [[ -n "$STORAGE_PATH" ]]; then
          # Delete storage object from card-photos bucket
          DEL_STORAGE="$(curl -sS -w "\n%{http_code}" -X DELETE \
            "${SUPABASE_URL}/storage/v1/object/card-photos/${STORAGE_PATH}" \
            -H "apikey: ${SERVICE_ROLE_KEY}" \
            -H "Authorization: Bearer ${SERVICE_ROLE_KEY}")"
          DEL_HTTP="$(echo "$DEL_STORAGE" | tail -n1)"

          # Delete card_photos DB row
          curl -sS -X DELETE \
            "${SUPABASE_URL}/rest/v1/card_photos?library_card_id=eq.${LC_ID}" \
            -H "apikey: ${SERVICE_ROLE_KEY}" \
            -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
            -H "Prefer: return=minimal" > /dev/null 2>&1 || true

          if [[ "$DEL_HTTP" -ge 200 && "$DEL_HTTP" -lt 300 ]]; then
            PHOTO_COUNT=$((PHOTO_COUNT + 1))
          fi
        fi
      fi
    done <<< "$LIBRARY_CARD_IDS"

    if [[ "$PHOTO_COUNT" -gt 0 ]]; then
      echo "[$(date -u +%H:%M:%S)] expire-listings: ${PHOTO_COUNT} card photo(s) purged"
    fi
  fi
  # ---- End Phase 15 extension ----

elif echo "$BODY" | grep -q '"42703"'; then
  # migration-009 not applied yet — no expires_at column, nothing to sweep
  echo "[$(date -u +%H:%M:%S)] expire-listings: skipped (migration-009 pending)"
else
  echo "[$(date -u +%H:%M:%S)] expire-listings: ERROR — HTTP ${HTTP_CODE}: ${BODY}" >&2
  exit 1
fi
