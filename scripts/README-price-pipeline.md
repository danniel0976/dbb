# DBB CardKingdom Price Pipeline

**Rule: CardKingdom is the baseline price source.** Scryfall prices are a fallback
only and must always be labeled "market", never "CKD".

## The Problem This Solves

- MTGJSON `AllPricesToday` has real CardKingdom prices, but keys them by
  **MTGJSON UUIDs**. Our DB and API use **Scryfall IDs**.
- The uuid→scryfall translation lives in MTGJSON `AllIdentifiers` (~600MB
  decompressed) — **too big for the VPS (1.9GB RAM, OOMs every time)**.

## Architecture

```
MacBook (16GB, rare)                    VPS (1.9GB, daily 01:00 MYT)
────────────────────                    ─────────────────────────────
build-ck-cache-macbook.py               build-price-cache.js
  AllIdentifiers + AllPricesToday         ck-uuid-map.json.gz (~5MB)
  → ck-prices.json                        + AllPricesToday (~5MB gz)
  → ck-uuid-map.json.gz  ──── scp ──→     → ck-prices.json
                                          → upload to Supabase Storage
                                               │
                              Vercel /api/pricing reads it from
                              Storage bucket `price-cache` (public)
```

- **`ck-uuid-map.json.gz`** — `{mtgjsonUuid: [scryfallId, name]}` for the ~97k
  CK-priced cards. Committed to this repo (scripts/data/) AND uploaded to the
  Storage bucket. Only needs rebuilding when many new sets release (the daily
  job prints an `unmapped` count — rebuild when it grows past a few hundred).
- **`ck-prices.json`** — `{prices: {scryfallId: {n,f,b}}, names: {...}, _meta}`.
  `n`/`f` = CK retail normal/foil, `b` = CK buylist normal, all USD.
  Regenerated daily; lives in Supabase Storage. NOT committed (7MB daily churn).
- **names index** — cheapest normal-retail printing per card name; the API uses
  it when the DB's scryfall_id is a printing CK doesn't stock. Cheapest wins so
  fallback quotes never overprice.

## Daily Refresh (VPS)

OpenClaw cron job `dbb-price-cache-refresh` (01:00 MYT) runs:

```bash
cd /root/.openclaw/workspace/dbb && node --max-old-space-size=512 scripts/build-price-cache.js
```

Takes ~10s, peak ~400MB RSS. Verifies DB coverage at the end
(expect: `1768 cards — 1762 by id, 6 by name, 0 missing`, counts drift as the
collection changes).

## Rebuilding the UUID Map (MacBook, occasional)

```bash
scp scripts/build-ck-cache-macbook.py macbook:/tmp/
ssh macbook 'cd /tmp && nohup python3 build-ck-cache-macbook.py > ck-build.log 2>&1 &'
# wait a few minutes, check: ssh macbook 'tail /tmp/ck-build.log'
scp macbook:~/dbb-price-build/ck-uuid-map.json.gz scripts/data/
# then re-upload the map + fresh cache:
node scripts/build-price-cache.js
# and upload the new map to Storage (service key in nextjs/.env.local):
# curl -X POST "$URL/storage/v1/object/price-cache/ck-uuid-map.json.gz" \
#   -H "Authorization: Bearer $SERVICE_KEY" -H "x-upsert: true" \
#   -H "Content-Type: application/gzip" --data-binary @scripts/data/ck-uuid-map.json.gz
```

## Hard Rules

1. **NEVER parse AllIdentifiers / AllPrintings on the VPS.** Node hits the V8
   string limit, Python OOMs. Confirmed five different ways on 2026-07-08.
   Big parses go to the MacBook (`ssh macbook`).
2. **mtgjson.com 403s default script user-agents** — send a browser-ish UA.
3. Supabase Storage bucket: `price-cache` (public). Project `mnyhpwqskzadkplnhbrx`.
   Service role key in `nextjs/.env.local`.
