# DBB Architecture Analysis

## Current State

### Source Code
- **GitHub**: `danniel0976/dbb` (public repo)
- **Framework**: Next.js 14 (App Router), Tailwind CSS
- **Hosting**: Vercel (project `dbb-chippyandluke`)
- **Database**: Supabase (project `mnyhpwqskzadkplnhbrx` — FROZEN/PAUSED, needs reactivation)
- **Deployment URL**: `dbb.lovelikenotomorrow.com` (+ `www.dbb` redirect)

### What's Broken
1. **Supabase project is frozen** — the free tier pauses after 1 week of inactivity
2. `/api/pricing` route returns Scryfall/TCGPlayer prices, NOT CardKingdom — the `ckd_usd_price` label is misleading
3. Prices are frozen at import time (stale exchange rate ~4.7 MYR/USD)
4. No caching on `/api/pricing` — every card detail view hits Scryfall

### Architecture Flow
```
ManaBox CSV → import-collection.js → Supabase (cards table)
                                            ↓
Browser → page.js → supabase.js (cardQueries) → Supabase (card data)
                                            ↓
       → CardDetail.js → enrichCardWithPricing() → /api/pricing → Scryfall (NOT CardKingdom!)
       → CardGrid.js → enrichCardsWithImages() → /api/scryfall → Scryfall (images)
```

### Key Files
- `nextjs/src/lib/supabase.js` — Supabase client, card queries, price utils, caption generator
- `nextjs/src/lib/api.js` — Scryfall + MTGJson API clients, CardKingdom price lookup (NOT USED in production route!)
- `nextjs/src/app/api/pricing/route.js` — **ONLY calls Scryfall**, ignores MTGJson/CardKingdom
- `nextjs/src/app/api/scryfall/route.js` — Scryfall image proxy
- `nextjs/src/app/page.js` — Main page, loads cards from Supabase
- `nextjs/src/components/CardGrid.js` — Card grid display
- `nextjs/src/components/CardDetail.js` — Card detail modal
- `scripts/import-collection.js` — CSV import (uses MTGJson for CK prices during import)
- `supabase/schema.sql` — Database schema with triggers for MYR price calculation

### Supabase Schema
- `dbb.cards` — Main table (UUID, scryfall_id, card_name, set_code, rarity, ckd_usd_price, MYR prices, images, etc.)
- `dbb.price_history` — Historical tracking (not actively used)
- `dbb.exchange_rates` — USD/MYR rate (default 4.70)
- Auto-calculates MYR prices via trigger: `ckd_usd_price * usd_myr_rate * multiplier`

### ManaBox CSV Format
```
Binder Name, Binder Type, Name, Set code, Set name, Collector number,
Foil, Rarity, Quantity, ManaBox ID, Scryfall ID, Purchase price,
Misprint, Altered, Condition, Language, Purchase price currency
```

### Pricing Issue
- **Import script** (`api.js`) correctly fetches CardKingdom prices via MTGJson
- **Production route** (`pricing/route.js`) calls Scryfall which returns TCGPlayer prices
- The `ckd_usd_price` field in Supabase is whatever was imported — NOT live CardKingdom
- Result: displayed "CKD" prices are actually TCGPlayer/market prices

## Desired Changes

1. **CardKingdom prices as default benchmark** — use MTGJson `AllPricesToday` for daily CK prices
2. **Sync with ManaBox CSV** — upload CSV, match cards by Scryfall ID
3. **No card data stored in Supabase** — only keep minimal inventory (which cards, condition, quantity)
4. **Fast loading** — card data (images, names, etc.) from Scryfall; prices from MTGJson daily
5. **Latest CK price only** — no historical pricing needed
6. **Keep Supabase always running** — prevent freeze on free tier

## Supabase Free Tier Wake-Up
Supabase free tier pauses after 7 days of inactivity. Options:
- Ping the Supabase URL periodically (cron/heartbeat)
- Upgrade to Pro ($25/mo)
- Replace Supabase with a different backend