# Dan's Bizarre Bazaar (DBB)

**MTG Card Claim Sales System for Facebook Group**

A modern, mobile-first web application for managing and selling Magic: The Gathering cards through Facebook group claim sales.

## Features

- 📱 **Mobile-First Design** - Optimized for mobile browsing and Facebook integration
- 🎨 **Stylish UI** - Minimalist, dark theme with MTG-inspired color palette
- 🔍 **Advanced Filtering** - Filter by set, rarity, color, type, price, and foil status
- 💰 **Dynamic Pricing** - Auto-calculates MYR prices from CardKingdom USD with configurable multipliers (2.5x, 2.8x, 3.0x)
- 📸 **Official Artwork** - High-quality card images from Scryfall API
- 📋 **Easy Copy Captions** - One-click copy of formatted Facebook post captions
- 🗄️ **Supabase Backend** - Fast, scalable database with real-time updates

## Tech Stack

- **Frontend:** Next.js 14 (App Router), React 18, Tailwind CSS
- **Backend:** Supabase (PostgreSQL)
- **APIs:** Scryfall (card data), CardKingdom (pricing)
- **Deployment:** Vercel

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Supabase account and project
- Git

### 1. Clone & Install

```bash
cd nextjs
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Supabase credentials:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

### 3. Set Up Supabase

Run the SQL migration in Supabase SQL Editor:

```bash
# In Supabase Dashboard > SQL Editor
# Paste contents of: ../supabase/schema.sql
```

This creates:
- `dbb` schema
- `cards`, `price_history`, `exchange_rates` tables
- RLS policies
- Automatic MYR price calculation triggers

### 4. Import Your Collection

Prepare your ManaBox CSV export with columns:
- Card Name
- Set (set code)
- Collector No
- Foil (true/false or Yes/No)
- Condition (optional, defaults to NM)

Run the import script:

```bash
node scripts/import-collection.js /path/to/your/collection.csv
```

The script will:
1. Parse your CSV
2. Fetch card data from Scryfall API
3. Get USD prices from CardKingdom API
4. Calculate MYR prices (2.5x, 2.8x, 3.0x)
5. Insert into Supabase

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Deployment to Vercel

### 1. Push to Git

```bash
git init
git add .
git commit -m "Initial DBB commit"
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. Connect to Vercel

1. Go to [vercel.com](https://vercel.com)
2. Import your Git repository
3. Configure build settings:
   - **Framework Preset:** Next.js
   - **Root Directory:** `nextjs`
   - **Build Command:** `npm run build`
   - **Output Directory:** `.next`

### 3. Set Environment Variables in Vercel

In Vercel Project Settings > Environment Variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
USD_MYR_RATE=4.70
NEXT_PUBLIC_SITE_URL=https://dbb.lovelikenotomorrow.com
```

### 4. Deploy

Click **Deploy**. Vercel will build and deploy your app.

### 5. Configure Custom Domain

In Vercel Project Settings > Domains:
- Add `dbb.lovelikenotomorrow.com`
- Update DNS records as instructed

## Project Structure

```
dbb/
├── supabase/
│   └── schema.sql              # Database schema & migrations
├── nextjs/
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.js         # Main page
│   │   │   ├── layout.js       # Root layout
│   │   │   └── globals.css     # Global styles
│   │   ├── components/
│   │   │   ├── Sidebar.js      # Filter sidebar
│   │   │   ├── CardGrid.js     # Card grid display
│   │   │   ├── CardDetail.js   # Card detail modal
│   │   │   └── LoadingSkeleton.js
│   │   └── lib/
│   │       ├── supabase.js     # Supabase client & queries
│   │       └── api.js          # Scryfall & CKD API clients
│   ├── public/                 # Static assets
│   ├── package.json
│   ├── tailwind.config.js
│   └── next.config.js
├── scripts/
│   └── import-collection.js    # Collection import script
└── docs/
    └── README.md               # This file
```

## API Integration

### Scryfall API

- **Base URL:** `https://api.scryfall.com`
- **Rate Limit:** ~10 requests/second recommended
- **Usage:** Card data, images, set info, collector numbers
- **User-Agent:** Must be set (e.g., `DansBizarreBazaar/1.0`)

Endpoints used:
- `GET /cards/named?set={code}&number={collector_number}` - Get specific card
- `GET /cards/search?q={query}` - Search cards

### CardKingdom API

- **Base URL:** `https://api.cardkingdom.com/api/v2`
- **Endpoint:** `/pricelist`
- **Auth:** None required for public pricelist
- **Rate Limit:** Be respectful; cache the pricelist (recommended: 24h)

The pricelist includes:
- `ScryfallID` - Links to Scryfall data
- `PriceRetail` - USD retail price
- `PriceBuy` - USD buy price
- `IsFoil` - Foil status

## Database Schema

### dbb.cards

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| scryfall_id | UUID | Scryfall card ID (unique) |
| card_name | TEXT | Card name |
| set_code | TEXT | Set code (e.g., LCI) |
| collector_number | TEXT | Collector number |
| rarity | TEXT | common/uncommon/rare/mythic |
| card_type | TEXT | Type line |
| colors | TEXT[] | Color identity |
| is_foil | BOOLEAN | Foil status |
| condition | TEXT | NM/LP/MP/HP/DMG |
| ckd_usd_price | DECIMAL | CardKingdom USD price |
| myr_price_2_5 | DECIMAL | MYR price @ 2.5x |
| myr_price_2_8 | DECIMAL | MYR price @ 2.8x (default) |
| myr_price_3_0 | DECIMAL | MYR price @ 3.0x |
| usd_myr_rate | DECIMAL | Exchange rate used |
| image_png_url | TEXT | Full card image URL |
| image_crop_url | TEXT | Art crop URL |
| is_available | BOOLEAN | Availability flag |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |

## Facebook Workflow

1. Browse cards on DBB website
2. Click card to open detail modal
3. Select multiplier (2.5x, 2.8x, 3.0x)
4. Click copy button on caption
5. Create Facebook post in group thread
6. Paste caption + upload card screenshot
7. Mark card as sold in DBB when claimed

### Caption Format

```
Roaming Throne
R 0258
LCI
CKD: 54.99
CKD 2.5 / 2.8 / 3.0: RM 643.61 / RM 720.85 / RM 772.34
Your price (2.8x): RM 720.85
✨ FOIL ✨
```

## Maintenance

### Update Exchange Rate

Update in Supabase:

```sql
UPDATE dbb.exchange_rates 
SET usd_myr_rate = 4.75 
WHERE id = (SELECT id FROM dbb.exchange_rates ORDER BY recorded_at DESC LIMIT 1);

-- Recalculate all card prices
UPDATE dbb.cards 
SET usd_myr_rate = 4.75 
WHERE is_available = TRUE;
```

### Refresh CardKingdom Prices

Re-run import script or create a scheduled function:

```bash
node scripts/import-collection.js ./current-collection.csv
```

### Add New Cards

Use the import script with a CSV of new cards only, or insert directly via Supabase Dashboard.

## Troubleshooting

### Cards Not Loading

1. Check Supabase connection in browser console
2. Verify RLS policies allow public read access
3. Check `is_available` flag is TRUE

### Import Script Fails

1. Verify CSV column names match expected format
2. Check Scryfall API rate limiting (increase DELAY_MS)
3. Review `failed-imports.json` for specific errors

### Prices Not Calculating

1. Ensure CardKingdom API is accessible
2. Check `usd_myr_rate` is set
3. Verify trigger `trg_calculate_myr_prices` exists

## License

MIT License - See LICENSE file

## Credits

- **Scryfall** - Card data and images (https://scryfall.com)
- **CardKingdom** - Pricing data (https://cardkingdom.com)
- **Supabase** - Database and backend (https://supabase.com)
- **Next.js** - React framework (https://nextjs.org)

---

Built with ❤️ for Dan's MTG community
