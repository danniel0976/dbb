# DBB Quick Start Guide

**Get your MTG claim sales system running in 15 minutes!**

## Prerequisites

- ✅ Node.js 18+ installed
- ✅ Supabase account (free tier works)
- ✅ Git installed
- ✅ Your MTG collection exported from ManaBox (CSV)

---

## Step 1: Set Up Supabase (5 min)

### 1.1 Create Project

1. Go to https://supabase.com
2. Click **New Project**
3. Choose your organization
4. Enter project name: `DBB` or `Dans-Bizarre-Bazaar`
5. Set database password (save it!)
6. Select region closest to you
7. Click **Create new project** (takes ~2 minutes)

### 1.2 Create Database Schema

1. In Supabase Dashboard, go to **SQL Editor** (left sidebar)
2. Click **New Query**
3. Copy entire contents of `supabase/schema.sql`
4. Paste into SQL Editor
5. Click **Run** (or Ctrl+Enter / Cmd+Enter)
6. Verify success message

You should see:
- ✅ Schema `dbb` created
- ✅ Tables: `cards`, `price_history`, `exchange_rates`
- ✅ Triggers and policies created

### 1.3 Get API Keys

1. Go to **Project Settings** (gear icon)
2. Click **API**
3. Copy these values:
   - **Project URL:** `https://xxxxx.supabase.co`
   - **anon/public key:** `eyJhbG...` (long string)
   - **service_role key:** `eyJhbG...` (⚠️ keep secret!)

---

## Step 2: Install & Configure (3 min)

### 2.1 Install Dependencies

```bash
cd /root/.openclaw/workspace/dbb/nextjs
npm install
```

Wait for installation to complete (~1-2 minutes).

### 2.2 Create Environment File

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```bash
# Replace with YOUR values from Step 1.3
NEXT_PUBLIC_SUPABASE_URL=https://mnyhpwqskzadkplnhbrx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
USD_MYR_RATE=4.70
```

**⚠️ Important:** Never commit `.env.local` to Git!

---

## Step 3: Import Your Collection (5 min)

### 3.1 Prepare CSV

Export from ManaBox or create CSV with these columns:

```csv
Card Name,Set,Collector No,Foil,Condition
Roaming Throne,LCI,258,false,NM
Lightning Bolt,LCI,159,true,NM
```

Save as `my-collection.csv`

### 3.2 Run Import Script

```bash
node scripts/import-collection.js /path/to/my-collection.csv
```

Watch the progress:
```
🚀 Starting DBB Collection Import

📁 CSV File: my-collection.csv
💱 Exchange Rate: 1 USD = 4.70 MYR

📊 Parsed 150 cards from CSV
💰 Fetching CardKingdom pricelist...
   Loaded 25000 prices from CardKingdom

⚙️  Processing 150 cards in batches of 10...

📦 Batch 1/15 (10 cards)
   ✅ Inserted: Roaming Throne
   ✅ Inserted: Lightning Bolt
   ✓ 10 succeeded, 0 failed

...

📊 IMPORT SUMMARY
==================================================
✅ Total Success: 150
   ├─ Inserted: 148
   └─ Updated: 2
❌ Total Failed: 0
==================================================

✨ Import complete!
```

### 3.3 Verify in Supabase

1. Go to Supabase Dashboard
2. Click **Table Editor** (left sidebar)
3. Select schema: `dbb`
4. Select table: `cards`
5. You should see your imported cards!

---

## Step 4: Run Locally (2 min)

### 4.1 Start Development Server

```bash
npm run dev
```

You should see:
```
✓ Ready in 2s
○ Local: http://localhost:3000
```

### 4.2 Open in Browser

Navigate to http://localhost:3000

You should see:
- ✅ Dark themed UI with "Dan's Bizarre Bazaar" header
- ✅ Grid of your imported cards
- ✅ Sidebar with filters (Set, Rarity, Colors, etc.)
- ✅ Card images from Scryfall
- ✅ Prices in MYR

### 4.3 Test Features

1. **Filter Cards:**
   - Click "Rare" in Rarity filter
   - Select colors (W, U, B, R, G)
   - Set price range

2. **View Card Details:**
   - Click any card
   - See full-size image
   - View pricing breakdown

3. **Copy Caption:**
   - In card detail modal
   - Select multiplier (2.5x, 2.8x, 3.0x)
   - Click copy button (📋 icon)
   - Paste somewhere to verify

Caption format:
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

## Step 5: Deploy to Vercel (Optional, 5 min)

### 5.1 Push to Git

```bash
cd /root/.openclaw/workspace/dbb
git init
git add .
git commit -m "Initial DBB setup"

# Create repo on GitHub first, then:
git remote add origin https://github.com/yourusername/dbb.git
git push -u origin main
```

### 5.2 Deploy on Vercel

1. Go to https://vercel.com/new
2. Click **Import Git Repository**
3. Select your `dbb` repository
4. Configure:
   - **Framework Preset:** Next.js
   - **Root Directory:** `nextjs`
   - Leave other defaults
5. Click **Deploy**

### 5.3 Add Environment Variables

In Vercel Dashboard > Project Settings > Environment Variables:

Add these (Production environment):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` ⚠️ Production only
- `USD_MYR_RATE` = `4.70`

Redeploy after adding variables.

### 5.4 Add Custom Domain (Optional)

1. Vercel > Project Settings > Domains
2. Add: `dbb.lovelikenotomorrow.com`
3. Update DNS at your domain registrar:
   ```
   Type: CNAME
   Name: dbb
   Value: cname.vercel-dns.com
   ```
4. Wait for propagation (up to 48 hours)

---

## Next Steps

### Daily Use

1. Browse your collection at dbb.lovelikenotomorrow.com
2. Find card you want to sell
3. Click card → Copy caption
4. Create Facebook post in group thread
5. Upload card screenshot
6. Paste caption
7. When sold, mark as unavailable in Supabase

### Maintenance

**Update Exchange Rate:**
```sql
-- In Supabase SQL Editor
UPDATE dbb.cards SET usd_myr_rate = 4.75 WHERE is_available = TRUE;
```

**Add New Cards:**
```bash
node scripts/import-collection.js new-cards.csv
```

**Mark Card as Sold:**
```sql
UPDATE dbb.cards SET is_available = FALSE WHERE id = 'card-uuid';
```

---

## Troubleshooting

### "Missing Supabase environment variables"

- Check `.env.local` exists in `nextjs/` folder
- Verify all three keys are present and correct
- Restart dev server after changes

### Cards not appearing

1. Check Supabase Table Editor for data
2. Verify `is_available = TRUE`
3. Check browser console for errors
4. Test RLS policies in Supabase

### Import script fails

- Check CSV encoding is UTF-8
- Verify column names match exactly
- Increase delay if rate limited: edit script, change `DELAY_MS = 300`
- Check `failed-imports.json` for details

### Build fails on Vercel

- Check build logs for errors
- Verify all dependencies in `package.json`
- Ensure Node.js version is 18+

---

## Need Help?

- 📖 Full documentation: `docs/README.md`
- 🔧 Deployment guide: `docs/DEPLOYMENT.md`
- 📡 API details: `docs/API.md`
- 💬 Support: Check GitHub issues or contact Dan

---

**Congratulations! 🎉** Your DBB system is ready to use!
