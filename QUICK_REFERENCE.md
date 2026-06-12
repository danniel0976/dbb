# DBB Quick Reference Card

## 🚀 One-Liner Commands

### Start Local Dev
```bash
cd /root/.openclaw/workspace/dbb/nextjs && npm run dev
```

### Import Collection
```bash
cd /root/.openclaw/workspace/dbb && node scripts/import-collection.js my-collection.csv
```

### Check Supabase Tables
Go to: https://supabase.com/dashboard/project/mnyhpwqskzadkplnhbrx/editor

---

## 📁 Important Paths

- **Project Root:** `/root/.openclaw/workspace/dbb/`
- **Next.js App:** `/root/.openclaw/workspace/dbb/nextjs/`
- **Setup Guide:** `/root/.openclaw/workspace/dbb/SETUP_INSTRUCTIONS.md`
- **Your CSV:** Place at `/root/.openclaw/workspace/dbb/my-collection.csv`

---

## 🔑 Supabase Info

- **Project URL:** https://mnyhpwqskzadkplnhbrx.supabase.co
- **Dashboard:** https://supabase.com/dashboard/project/mnyhpwqskzadkplnhbrx
- **Schema:** `dbb`
- **Main Table:** `dbb.cards`

---

## 💡 Caption Format

```
Card Name
Rarity CollectorNumber
SetCode
CKD: $USD_Price
CKD 2.5 / 2.8 / 3.0: RM_Price1 / RM_Price2 / RM_Price3
Your price (2.8x): RM_Final_Price
✨ FOIL ✨ (if foil)
```

Example:
```
Roaming Throne
M 0258
LCI
CKD: $54.99
CKD 2.5 / 2.8 / 3.0: RM 643.61 / RM 720.85 / RM 772.34
Your price (2.8x): RM 720.85
✨ FOIL ✨
```

---

## 🎯 Default Settings

- **Multiplier:** 2.8x
- **Exchange Rate:** 1 USD = 4.70 MYR
- **Condition:** NM (Near Mint)
- **Foil:** false (unless specified)

---

## 🔧 Common Tasks

### Mark Card as Sold
In Supabase SQL Editor:
```sql
UPDATE dbb.cards 
SET is_available = FALSE, notes = 'Sold on 2026-06-12' 
WHERE card_name = 'Roaming Throne';
```

### Update Exchange Rate
```sql
UPDATE dbb.cards 
SET usd_myr_rate = 4.75 
WHERE is_available = TRUE;
```

### Add New Cards
1. Save new cards to CSV
2. Run: `node scripts/import-collection.js new-cards.csv`

### Check Failed Imports
```bash
cat /root/.openclaw/workspace/dbb/failed-imports.json
```

---

## 🌐 Deployment

- **Vercel Dashboard:** https://vercel.com/dashboard
- **Custom Domain:** dbb.lovelikenotomorrow.com
- **DNS:** CNAME dbb → cname.vercel-dns.com

---

## 📊 Project Stats

- **Files Created:** 25
- **Lines of Code:** ~4,000
- **Components:** 4 React components
- **APIs:** Scryfall + CardKingdom

---

**Questions? Ask Chippy! 🐕**
