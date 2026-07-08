# DBB Sort/Filter Research & Recommendation

## What the Big Players Offer

### Scryfall (Gold Standard)
**Search**: Full-text syntax search (name, type, oracle text, mana cost, etc.)
**Filters**: Color, Color Identity, Rarity, Set, Format legality, CMC/Mana Value, Price (USD/EUR/TIX), Foil, Border, Frame, Artist, Power/Toughness, Layout, Language, etc.
**Sort**: Name, Release Date, Set/Number, Rarity, Color, Price (USD/TIX/EUR), Mana Value, Power, Toughness, Artist, EDHREC Rank
**UX**: Dropdown for Sort + Direction (Asc/Desc), separate dropdowns for View mode. Filters via syntax bar (power user) or Advanced Search form (casual).

### MTG Goldfish
**Filters**: Format (Standard/Pioneer/Modern/etc.), Set, Rarity, Color, Type
**Sort**: Price (daily/weekly changes), Name, Rarity
**UX**: Tab-based navigation, simple dropdown filters. Price-focused — their core UX is around price trends.

### Manabox (Mobile App)
**Filters**: Color, Rarity, Set, Type, CMC, Price range, Foil, Condition, Artist
**Sort**: Name, Price, Set, Rarity, CMC, Quantity, Date added
**UX**: Bottom sheet filter panel, chip-based selections, clean mobile-first UI.

### Cardmarket / CardKingdom (Singles Shops)
**Filters**: Set, Rarity, Color, Price range, Condition, Foil, Language
**Sort**: Price (asc/desc), Name, Popularity, Date listed
**UX**: Left sidebar filters, sort dropdown in header. Shops prioritize PRICE as the primary sort axis.

## Current DBB State

### What's in the DB (populated):
- `card_name` ✅
- `set_code` / `set_name` ✅ (102 sets)
- `rarity` ✅ (common/uncommon/rare/mythic)
- `is_foil` ✅ (true/false)
- `condition` ✅ (currently all "NM")
- `ckd_usd_price` ✅ (source price in USD)
- `myr_price_2_5`, `myr_price_2_8`, `myr_price_3_0` ✅ (selling prices in RM)
- `image_png_url` / `image_crop_url` ✅

### What's in the DB (ALL NULL):
- `card_type` ❌ — not imported
- `colors` ❌ — not imported
- No `cmc` / `mana_value` column
- No `oracle_text` column
- No `power` / `toughness` column

### What's already in the UI:
- Sidebar with: Set, Rarity, Color (WUBRG buttons), Card Type, Foil, Price Range
- Sort dropdown (just added): Newest, Price High/Low, Name A-Z, Rarity

## Recommendation for DBB

**Philosophy**: DBB is a **card shop**, not a search engine or collection manager. Buyers want to:
1. Find cards quickly (search by name)
2. Browse by price (most important for a shop)
3. Narrow down by what they care about (set, rarity, foil)
4. See what's new

### Search — ADD
**Text search by card name.** This is the #1 missing feature. Every shop has it. Simple `ILIKE` search on `card_name`. No need for Scryfall-style syntax — just a search box.

### Filters — KEEP existing, FIX broken ones
The sidebar already has the right structure. Problem: `colors` and `card_type` are NULL in the DB, making those filters useless.

1. **Set** ✅ — works, keep it
2. **Rarity** ✅ — works, keep it
3. **Price Range** ✅ — works, keep it (uses myr_price_2_8 as baseline)
4. **Foil** ✅ — works, keep it
5. **Color** ⚠️ — filter UI exists but DB has no data. Fix: import colors from MTGJSON
6. **Card Type** ⚠️ — filter UI exists but DB has no data. Fix: import card_type from MTGJSON

### Sort — DONE ✅
Already implemented: Newest, Price High/Low, Name A-Z, Rarity

### What NOT to add (shop doesn't need it)
- ~~Format legality~~ (not a deck builder)
- ~~CMC/Mana Value~~ (overkill for browsing singles)
- ~~Oracle text search~~ (use Scryfall for that)
- ~~Power/Toughness~~ (not a combat simulator)
- ~~Artist~~ (nice-to-have, very few buyers filter by this)
- ~~Language~~ (all cards are English)
- ~~Condition~~ (everything is NM)

### Priority Implementation Order
1. **Search bar** — text search on card name (HIGH IMPACT, easy)
2. **Import colors & card_type** — populate from MTGJSON (fixes existing filters)
3. Sort is already done ✅

## UX Pattern Recommendation

```
┌─────────────────────────────────────────────┐
│ 🔍 [Search by card name...]  Sort: [Newest ▼] │
├──────────┬──────────────────────────────────┤
│ Set      │  Card Grid...                     │
│ Rarity   │                                   │
│ Color    │                                   │
│ Type     │                                   │
│ Foil     │                                   │
│ Price    │                                   │
└──────────┴──────────────────────────────────┘
```

Search bar in the header, sort dropdown next to it. Sidebar unchanged (just needs data fixes).