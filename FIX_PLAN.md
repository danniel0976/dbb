# DBB Fix Plan — 2026-07-08

## Status: IN PROGRESS

### Critical Bugs Fixed (written to disk, pending git push & deploy)

#### 1. `/api/pricing` — WRONG PRICES ✅ FIXED
- **Bug**: Route called Scryfall API, returned TCGPlayer/market prices labeled as "ckd_usd_price"
- **Fix**: Rewritten to use MTGJSON AllPricesToday API for real CardKingdom prices
- **File**: `nextjs/src/app/api/pricing/route.js` (complete rewrite)
- **Changes**:
  - Fetches `https://mtgjson.com/api/v5/AllPricesToday.json.gz`
  - Caches CK prices in memory for 24 hours
  - Returns real CK retail, foil, and buylist prices
  - Calculates MYR prices server-side (2.5x, 2.8x, 3.0x)
  - Falls back to Scryfall if MTGJSON doesn't have a card, but labels it correctly as "market" not "CKD"
  - Supports `?refresh=true` for Vercel cron to force cache refresh
  - Returns MYR prices directly so client doesn't need to calculate
  - `Cache-Control: public, s-maxage=3600` for CDN caching

#### 2. Client-side pricing enrichment ✅ FIXED
- **File**: `nextjs/src/lib/supabase.js`
- **Changes**:
  - `enrichCardWithPricing()` now handles new API response format
  - Picks up `myr_foil_price_*` fields for foil pricing
  - Tracks `pricing_source` and `pricing_last_updated`
  - Falls back to DB prices if API fails

#### 3. CardDetail component ✅ UPDATED
- **File**: `nextjs/src/components/CardDetail.js`
- **Changes**:
  - Shows CardKingdom vs Market price source label
  - Displays foil MYR prices (2.5x, 2.8x, 3.0x) when available
  - Shows CK foil USD price separately
  - Caption generator uses "CKD" or "Market" label based on source
  - Shows price source and last-updated timestamp

#### 4. Supabase keep-alive ✅ ADDED
- **File**: `nextjs/src/app/api/health/route.js` (new)
- **Changes**:
  - Pings Supabase REST API to keep project awake
  - Returns `{ status, cards: count, timestamp }`
  - `Cache-Control: no-cache` so each hit actually reaches Supabase

#### 5. Vercel cron config ✅ ADDED
- **File**: `nextjs/vercel.json` (new)
- **Cron jobs**:
  - `/api/health` every 5 days at midnight (keep Supabase awake)
  - `/api/pricing?refresh=true` daily at 2 AM (refresh CK prices)

### Still TODO

#### 6. Import script improvements
- **File**: `scripts/import-collection.js`
- **Needed**:
  - Add `--refresh-prices` mode (re-fetch only prices for existing cards)
  - Add `--dry-run` flag
  - Fetch live USD/MYR exchange rate from `https://open.er-api.com/v6/latest/USD`
  - Better progress reporting
  - Verify CSV column mapping matches ManaBox format

#### 7. Verify Supabase schema
- **File**: `supabase/schema.sql`
- **Check**: Is it `dbb.cards` or `public.cards`? The import script and client code need to match.
- **Current code**: Uses `supabase.from('cards')` which defaults to `public` schema
- **Schema file**: Has both `dbb` schema and `public` references

#### 8. Deploy to Vercel
- Git push all changes
- Verify Vercel auto-deploys from `main` branch
- Check that env vars are set in Vercel (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, USD_MYR_RATE)

#### 9. Supabase wake-up
- Project `mnyhpwqskzadkplnhbrx` was paused but unfroze when we hit it
- Need to verify it stays awake (the Vercel cron will help)

#### 10. Re-import collection with correct CK prices
- After deploy, re-run import with `--refresh-prices` to update all `ckd_usd_price` values with real CK prices
- Current DB has TCGPlayer/Scryfall prices mislabeled as CK

### Architecture Changes Summary
| Before | After |
|--------|-------|
| `/api/pricing` → Scryfall → TCGPlayer prices labeled "CKD" | `/api/pricing` → MTGJSON AllPricesToday → real CardKingdom prices |
| No caching (hits Scryfall every time) | 24-hour in-memory cache + CDN cache headers |
| MYR prices only from DB (stale at import time) | Live MYR calculation with daily exchange rate |
| Supabase pauses after 7 days idle | Vercel cron pings `/api/health` every 5 days |
| No daily price refresh | Cron hits `/api/pricing?refresh=true` daily |
| Caption says "CKD" for all prices | Caption says "CKD" or "Market" based on actual source |