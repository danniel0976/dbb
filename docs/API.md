# DBB API Documentation

## Overview

DBB integrates with two external APIs:

1. **Scryfall API** - Card metadata, images, set information
2. **CardKingdom API** - USD pricing data

## Scryfall API

### Base URL
```
https://api.scryfall.com
```

### Authentication
None required. All endpoints are public.

### Rate Limits
- Recommended: ≤10 requests/second
- Use `User-Agent` header with app name/version
- Implement delays between requests (150ms recommended)

### Required Headers
```javascript
{
  'User-Agent': 'DansBizarreBazaar/1.0',
  'Accept': 'application/json'
}
```

### Endpoints Used

#### 1. Get Card by Set and Collector Number

**Endpoint:** `GET /cards/named`

**Parameters:**
- `set` (string): Set code (e.g., "LCI")
- `number` (string): Collector number (e.g., "258")

**Example:**
```
GET https://api.scryfall.com/cards/named?set=LCI&number=258
```

**Response:**
```json
{
  "object": "card",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "Roaming Throne",
  "set": "lci",
  "set_name": "The Lord of the Rings: Tales of Middle-earth Commander",
  "collector_number": "258",
  "rarity": "mythic",
  "type_line": "Legendary Artifact",
  "colors": [],
  "foil": true,
  "image_uris": {
    "png": "https://cards.scryfall.io/png/...",
    "art_crop": "https://cards.scryfall.io/art_crop/..."
  }
}
```

#### 2. Search Cards by Name

**Endpoint:** `GET /cards/search`

**Parameters:**
- `q` (string): Search query (Scryfall syntax)

**Example:**
```
GET https://api.scryfall.com/cards/search?q=%21%22Roaming+Throne%22+e%3Alci
```

Query syntax:
- `!"Card Name"` - Exact name match
- `e:set_code` - Filter by set
- `f:foil` - Foil only

**Response:**
```json
{
  "object": "list",
  "data": [
    { /* card object */ }
  ],
  "has_more": false,
  "total_cards": 1
}
```

### Error Handling

**404 Not Found:**
```json
{
  "object": "error",
  "code": "not_found",
  "status": 404,
  "details": "No card found"
}
```

**429 Too Many Requests:**
```json
{
  "object": "error",
  "code": "too_many_requests",
  "status": 429,
  "details": "Rate limit exceeded"
}
```

### Best Practices

1. **Cache Results:** Store Scryfall IDs to avoid repeated lookups
2. **Use Exact Matches:** Prefer `/cards/named` over search when possible
3. **Handle Errors Gracefully:** Cards may not exist in all sets
4. **Respect Rate Limits:** Add delays between requests

---

## CardKingdom API

### Base URL
```
https://api.cardkingdom.com/api/v2
```

### Authentication
None required for public pricelist.

### Rate Limits
- No official limit documented
- Be respectful; cache aggressively
- Recommended: Fetch once per 24 hours

### Endpoints Used

#### 1. Get Singles Pricelist

**Endpoint:** `GET /pricelist`

**Example:**
```
GET https://api.cardkingdom.com/api/v2/pricelist
```

**Response:**
```json
{
  "info": {
    "created_at": "2024-01-15T10:30:00Z",
    "next_update": "2024-01-16T10:30:00Z"
  },
  "products": [
    {
      "ID": 123456,
      "Sku": "mtg-lci-258-foil",
      "ScryfallID": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "URL": "https://www.cardkingdom.com/...",
      "Name": "Roaming Throne",
      "Variation": "",
      "Edition": "LCI",
      "IsFoil": true,
      "PriceRetail": "54.99",
      "QtyRetail": 3,
      "PriceBuy": "45.00",
      "QtyBuying": 10,
      "ConditionValues": {
        "NmPrice": "54.99",
        "NmQty": 3,
        "ExPrice": "49.49",
        "ExQty": 5,
        "VgPrice": "43.99",
        "VgQty": 2,
        "GPrice": "38.49",
        "GQty": 1
      }
    }
  ]
}
```

### Data Model

**Product Object:**
| Field | Type | Description |
|-------|------|-------------|
| ID | int | CardKingdom product ID |
| Sku | string | Stock keeping unit |
| ScryfallID | string | UUID linking to Scryfall |
| Name | string | Card name |
| Edition | string | Set code |
| IsFoil | boolean | Foil status |
| PriceRetail | string | USD retail price |
| PriceBuy | string | USD buy price |
| ConditionValues | object | Prices by condition |

**Note:** Numeric fields are returned as strings in JSON.

### Building Price Lookup

```javascript
function buildPriceLookup(pricelist) {
  const lookup = new Map()
  
  for (const product of pricelist.products) {
    if (product.ScryfallID) {
      lookup.set(product.ScryfallID.toLowerCase(), {
        ckd_usd_price: parseFloat(product.PriceRetail) || 0,
        ckd_buy_price: parseFloat(product.PriceBuy) || 0,
        is_foil: product.IsFoil || false,
      })
    }
  }
  
  return lookup
}
```

### Best Practices

1. **Cache Entire Pricelist:** Download once, use for all cards
2. **Update Daily:** Prices change frequently
3. **Match by ScryfallID:** Most reliable identifier
4. **Handle Missing Cards:** Not all cards have CKD prices
5. **Check Foil Status:** Separate entries for foil/non-foil

---

## Combined Workflow

### Import Process Flow

```
┌─────────────┐
│ ManaBox CSV │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ Parse CSV       │
│ Extract:        │
│ - Card Name     │
│ - Set Code      │
│ - Collector #   │
│ - Foil          │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐     ┌──────────────────┐
│ For Each Card:  │────▶│ Scryfall API     │
│                 │     │ Get card data    │
│                 │◀────│ + images         │
└──────┬──────────┘     └──────────────────┘
       │
       ▼
┌─────────────────┐     ┌──────────────────┐
│ Match with      │◀────│ CardKingdom API  │
│ Price Lookup    │     │ (cached)         │
└──────┬──────────┘     └──────────────────┘
       │
       ▼
┌─────────────────┐
│ Calculate MYR   │
│ 2.5x, 2.8x, 3.0x│
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ Insert to       │
│ Supabase DBB    │
└─────────────────┘
```

### Example Code

```javascript
async function processCard(cardInput, priceLookup, exchangeRate) {
  // 1. Fetch from Scryfall
  const scryfallData = await scryfallAPI.getCardBySetNumber(
    cardInput.set_code,
    cardInput.collector_number
  )
  
  // 2. Get price from CardKingdom lookup
  const priceInfo = cardkingdomAPI.findPrice(
    priceLookup,
    scryfallData.scryfall_id,
    cardInput.is_foil
  )
  
  // 3. Calculate MYR prices
  const ckdUsdPrice = priceInfo?.ckd_usd_price || 0
  
  return {
    ...scryfallData,
    ckd_usd_price: ckdUsdPrice,
    myr_price_2_5: ckdUsdPrice * exchangeRate * 2.5,
    myr_price_2_8: ckdUsdPrice * exchangeRate * 2.8,
    myr_price_3_0: ckdUsdPrice * exchangeRate * 3.0,
  }
}
```

---

## Supabase API

### Client Setup

```javascript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { db: { schema: 'dbb' } }
)
```

### Queries

#### Get Available Cards

```javascript
const { data, error } = await supabase
  .from('available_cards')
  .select('*')
  .eq('set_code', 'LCI')
  .eq('rarity', 'rare')
  .gte('myr_price_2_8', 50)
  .lte('myr_price_2_8', 200)
  .order('created_at', { ascending: false })
```

#### Insert Card

```javascript
const { data, error } = await supabase
  .from('cards')
  .insert([{
    card_name: 'Roaming Throne',
    set_code: 'LCI',
    collector_number: '258',
    rarity: 'mythic',
    ckd_usd_price: 54.99,
    is_foil: true,
    // ... other fields
  }])
  .select()
  .single()
```

#### Update Card

```javascript
const { data, error } = await supabase
  .from('cards')
  .update({ is_available: false })
  .eq('id', cardId)
  .select()
  .single()
```

### Row Level Security (RLS)

**Public Read Access:**
```sql
CREATE POLICY "Allow public read access to cards" ON dbb.cards
  FOR SELECT USING (TRUE);
```

**Authenticated Write Access:**
```sql
CREATE POLICY "Allow authenticated users to manage cards" ON dbb.cards
  FOR ALL USING (auth.role() = 'authenticated');
```

---

## Error Codes Reference

| Code | HTTP Status | Description | Resolution |
|------|-------------|-------------|------------|
| `not_found` | 404 | Card not found | Verify set code and collector number |
| `too_many_requests` | 429 | Rate limit exceeded | Add delay between requests |
| `bad_request` | 400 | Invalid parameters | Check query syntax |
| `internal_error` | 500 | Server error | Retry later |

---

## Support

- **Scryfall:** https://scryfall.com/contact
- **CardKingdom:** https://www.cardkingdom.com/contact-us
- **Supabase:** https://supabase.com/docs
