# DBB Setup Instructions for Dan

## ✅ What's Already Done

- [x] Project structure created (`/root/.openclaw/workspace/dbb/`)
- [x] Next.js dependencies installed (381 packages)
- [x] Environment file configured with your Supabase credentials
- [x] All code written and ready to deploy

---

## 📋 What You Need to Do

### Step 1: Run the Supabase Schema (5 minutes)

**Option A: Via Supabase Web Dashboard (Easiest)**

1. Go to https://supabase.com/dashboard/project/mnyhpwqskzadkplnhbrx
2. Click **SQL Editor** in the left sidebar
3. Click **New Query**
4. Open the file: `/root/.openclaw/workspace/dbb/supabase/schema.sql`
5. Copy ALL the contents
6. Paste into the SQL Editor
7. Click **Run** (or press Ctrl+Enter / Cmd+Enter)
8. Wait for success message

You should see something like:
```
Success. No rows returned.
```

9. Verify it worked:
   - Click **Table Editor** in left sidebar
   - At the top, click the schema dropdown (probably says "public")
   - Select **dbb** schema
   - You should see 3 tables: `cards`, `price_history`, `exchange_rates`

**Option B: Via Supabase CLI (If you prefer terminal)**

```bash
cd /root/.openclaw/workspace/dbb
supabase login
supabase link --project-ref mnyhpwqskzadkplnhbrx
supabase db push --schema dbb
```

Note: This requires you to authenticate with Supabase first.

---

### Step 2: Prepare Your Collection CSV (2 minutes)

Your ManaBox CSV should have these columns (minimum):
```csv
Card Name,Set,Collector No,Foil,Condition
Roaming Throne,LCI,258,false,NM
Lightning Bolt,LCI,159,true,NM
```

If your CSV has different column names, edit the import script at:
`/root/.openclaw/workspace/dbb/scripts/import-collection.js`

Look for the `parseCSV` function and update the column mappings.

Save your CSV as: `/root/.openclaw/workspace/dbb/my-collection.csv`

---

### Step 3: Import Your Collection (5-15 minutes)

Run this command:

```bash
cd /root/.openclaw/workspace/dbb
node scripts/import-collection.js my-collection.csv
```

You'll see progress like:
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
```

**Note:** The first run will take longer because it downloads the entire CardKingdom pricelist (~25,000 cards). Subsequent imports are faster!

If any cards fail to import, they'll be saved to:
`/root/.openclaw/workspace/dbb/failed-imports.json`

---

### Step 4: Test Locally (2 minutes)

```bash
cd /root/.openclaw/workspace/dbb/nextjs
npm run dev
```

You should see:
```
✓ Ready in 2s
○ Local: http://localhost:3000
```

Open your browser to http://localhost:3000

You should see:
- ✨ Dark themed UI
- 🎴 Your imported cards in a grid
- 📊 Sidebar filters (Set, Rarity, Colors, etc.)
- 💰 Prices in MYR

**Test the features:**
1. Click on a card → See detail modal
2. Change multiplier (2.5x / 2.8x / 3.0x)
3. Click the copy button → Caption is copied!
4. Try filters in the sidebar

Paste the copied caption somewhere to verify format:
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

### Step 5: Deploy to Vercel (10 minutes)

#### 5.1 Push to GitHub

```bash
cd /root/.openclaw/workspace/dbb
git init
git add .
git commit -m "Initial DBB setup"

# Create a new repo on GitHub first, then:
git remote add origin https://github.com/YOUR_USERNAME/dbb.git
git branch -M main
git push -u origin main
```

#### 5.2 Deploy on Vercel

1. Go to https://vercel.com/new
2. Click **Import Git Repository**
3. Select your `dbb` repository
4. Configure:
   - **Framework Preset:** Next.js
   - **Root Directory:** `nextjs`
   - Leave other defaults
5. Click **Deploy**

#### 5.3 Add Environment Variables

In Vercel Dashboard > Project Settings > Environment Variables:

Add these (for **Production** environment):

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://mnyhpwqskzadkplnhbrx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_9_9VB5sQ3jW75TUOcx4SiA_w_l9rWh2` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(Get from Supabase Dashboard > Settings > API)* ⚠️ |
| `USD_MYR_RATE` | `4.70` |

⚠️ **Important:** The `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` is a placeholder. Get the real one from:
- Supabase Dashboard > Project Settings > API > Service Role Key

Click **Redeploy** after adding variables.

#### 5.4 Add Custom Domain

1. Vercel > Project Settings > Domains
2. Add: `dbb.lovelikenotomorrow.com`
3. Update DNS at your domain registrar:

```
Type: CNAME
Name: dbb
Value: cname.vercel-dns.com
```

4. Wait for propagation (up to 48 hours, usually faster)

---

## 🎉 You're Done!

Your site will be live at:
- Local: http://localhost:3000
- Production: https://dbb.lovelikenotomorrow.com (after DNS propagation)

---

## 📱 Daily Use Workflow

1. Open dbb.lovelikenotomorrow.com on your phone
2. Browse/filter your collection
3. Find card you want to sell
4. Tap card → Detail modal opens
5. Select multiplier (default 2.8x)
6. Tap copy button
7. Open Facebook app → Go to group
8. Create new post in claim sales thread
9. Upload photo of actual card (from your phone)
10. Paste caption
11. Post!

When a card sells:
1. Go to Supabase Dashboard > Table Editor > dbb.cards
2. Find the card
3. Set `is_available = FALSE`
4. Or add a note like "Sold to Ahmad on 2026-06-12"

---

## 🔧 Troubleshooting

### "Missing Supabase environment variables"
- Check `.env.local` exists in `nextjs/` folder
- Restart dev server: `npm run dev`

### Cards not appearing in local dev
1. Check Supabase Table Editor for data
2. Verify schema is `dbb` not `public`
3. Check browser console for errors (F12)

### Import script fails
- Check CSV encoding is UTF-8
- Verify column names match exactly
- Check `failed-imports.json` for details

### Build fails on Vercel
- Check build logs in Vercel dashboard
- Ensure Node.js version is 18+
- Verify all dependencies in `package.json`

---

## 📚 Full Documentation

- **Quick Start:** `/root/.openclaw/workspace/dbb/docs/QUICKSTART.md`
- **Full README:** `/root/.openclaw/workspace/dbb/docs/README.md`
- **Deployment:** `/root/.openclaw/workspace/dbb/docs/DEPLOYMENT.md`
- **API Details:** `/root/.openclaw/workspace/dbb/docs/API.md`

---

## 🆘 Need Help?

Just ask Chippy! 🐕
