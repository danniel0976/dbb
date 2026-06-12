# 🎴 Dan's Bizarre Bazaar (DBB)

**MTG Card Claim Sales System for Facebook Groups**

A modern, mobile-first web application for managing and selling Magic: The Gathering cards through Facebook group claim sales.

![Status](https://img.shields.io/badge/status-ready-success)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features

- 📱 **Mobile-First Design** - Optimized for mobile browsing and Facebook integration
- 🎨 **Stylish Dark UI** - MTG-inspired color palette with rarity-based card borders
- 🔍 **Advanced Filtering** - Set, rarity, color, type, price range, foil status
- 💰 **Dynamic Pricing** - Auto-calculates MYR from CardKingdom USD (2.5x, 2.8x, 3.0x)
- 📸 **Official Artwork** - High-quality card images from Scryfall API
- 📋 **One-Click Captions** - Copy formatted Facebook post captions instantly
- 🗄️ **Supabase Backend** - Fast PostgreSQL with Row Level Security
- ⚡ **Next.js Frontend** - Fast, SEO-friendly, deployable on Vercel

---

## 🚀 Quick Start

**Get running in 15 minutes:**

```bash
# 1. Install dependencies
cd nextjs
npm install

# 2. Configure environment
cp .env.example .env.local
# Edit .env.local with your Supabase credentials

# 3. Set up database
# Run supabase/schema.sql in Supabase SQL Editor

# 4. Import your collection
node scripts/import-collection.js your-collection.csv

# 5. Start development server
npm run dev
```

👉 **Full quick start guide:** [`docs/QUICKSTART.md`](docs/QUICKSTART.md)

---

## 📁 Project Structure

```
dbb/
├── supabase/
│   └── schema.sql              # Database schema & migrations
├── nextjs/
│   ├── src/
│   │   ├── app/                # Next.js App Router pages
│   │   ├── components/         # React components
│   │   └── lib/                # API clients & utilities
│   ├── package.json
│   └── .env.example
├── scripts/
│   └── import-collection.js    # CSV import script
├── docs/                       # Documentation
└── README.md                   # This file
```

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | Next.js 14 + React 18 | UI framework |
| **Styling** | Tailwind CSS 3 | Utility-first CSS |
| **Backend** | Supabase | PostgreSQL + Auth + RLS |
| **Card Data** | Scryfall API | Card metadata + images |
| **Pricing** | CardKingdom API | USD market prices |
| **Hosting** | Vercel | Serverless deployment |

---

## 💡 How It Works

### Pricing Model

```
CardKingdom USD Price × Exchange Rate × Multiplier = MYR Price

Example:
$54.99 × 4.70 × 2.8 = RM 723.67
```

**Multipliers:**
- 2.5x - Budget friendly
- 2.8x - Default (recommended)
- 3.0x - Premium pricing

### Data Flow

```
ManaBox CSV → Scryfall API → CardKingdom API → Supabase → Next.js → You!
```

1. Export collection from ManaBox as CSV
2. Import script fetches card data from Scryfall
3. Get USD prices from CardKingdom
4. Calculate MYR prices with multipliers
5. Store in Supabase database
6. Browse and filter in web app
7. Copy captions for Facebook posts

---

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [`docs/QUICKSTART.md`](docs/QUICKSTART.md) | 15-minute setup guide |
| [`docs/README.md`](docs/README.md) | Complete documentation |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Vercel deployment checklist |
| [`docs/API.md`](docs/API.md) | API integration details |
| [`PROJECT_SUMMARY.md`](PROJECT_SUMMARY.md) | Project overview |

---

## 🔧 Configuration

### Environment Variables

Create `nextjs/.env.local`:

```bash
# Required
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
USD_MYR_RATE=4.70

# Optional
DEFAULT_MULTIPLIER=2.8
NEXT_PUBLIC_SITE_URL=https://dbb.lovelikenotomorrow.com
```

### Database Setup

Run [`supabase/schema.sql`](supabase/schema.sql) in Supabase SQL Editor to create:
- `dbb` schema
- Tables: `cards`, `price_history`, `exchange_rates`
- Triggers for automatic price calculation
- Row Level Security policies

---

## 📸 Screenshots

### Card Grid View
- Mobile-responsive grid layout
- Rarity-based border colors
- Foil badges
- Price display @ 2.8x default

### Filter Sidebar
- Set selection
- Rarity filtering
- Color identity
- Card type
- Price range
- Foil toggle

### Card Detail Modal
- Full-size card image
- Pricing breakdown (2.5x, 2.8x, 3.0x)
- One-click caption copy
- Card metadata

---

## 🎯 Usage Workflow

### For Sellers (Dan)

1. **Import Collection**
   ```bash
   node scripts/import-collection.js manabox.csv
   ```

2. **Browse Inventory**
   - Open dbb.lovelikenotomorrow.com
   - Use filters to find cards

3. **Create Facebook Post**
   - Click card → Copy caption
   - Post in Facebook group thread
   - Add card screenshot

4. **Mark as Sold**
   - Update `is_available = FALSE` in Supabase

### For Buyers

1. Browse Facebook group claim thread
2. See formatted card posts with prices
3. Comment to claim
4. Coordinate payment with seller

---

## 🚢 Deployment

### Deploy to Vercel

```bash
# Push to Git
git init
git add .
git commit -m "Initial commit"
git push -u origin main

# Then in Vercel:
# 1. Import repository
# 2. Set root directory: nextjs
# 3. Add environment variables
# 4. Deploy!
```

### Custom Domain

Configure DNS for `dbb.lovelikenotomorrow.com`:
```
Type: CNAME
Name: dbb
Value: cname.vercel-dns.com
```

👉 **Full deployment guide:** [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

---

## 🧪 Development

### Local Development

```bash
cd nextjs
npm install
npm run dev          # http://localhost:3000
```

### Import Test Collection

```bash
node scripts/import-collection.js docs/sample-collection.csv
```

### Run Linting

```bash
npm run lint
```

### Build for Production

```bash
npm run build
npm run start        # Production server
```

---

## 🗄️ Database Schema

### dbb.cards Table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| scryfall_id | UUID | Scryfall card ID |
| card_name | TEXT | Card name |
| set_code | TEXT | Set code (e.g., LCI) |
| collector_number | TEXT | Collector number |
| rarity | TEXT | common/uncommon/rare/mythic |
| is_foil | BOOLEAN | Foil status |
| ckd_usd_price | DECIMAL | CardKingdom USD price |
| myr_price_2_5 | DECIMAL | MYR @ 2.5x |
| myr_price_2_8 | DECIMAL | MYR @ 2.8x (default) |
| myr_price_3_0 | DECIMAL | MYR @ 3.0x |
| image_png_url | TEXT | Card image URL |
| is_available | BOOLEAN | Availability flag |

See [`supabase/schema.sql`](supabase/schema.sql) for full schema.

---

## 🔌 API Integration

### Scryfall API

- **Base URL:** https://api.scryfall.com
- **Rate Limit:** ~10 requests/second
- **Usage:** Card data, images, set info
- **Docs:** https://scryfall.com/docs/api

### CardKingdom API

- **Base URL:** https://api.cardkingdom.com/api/v2
- **Endpoint:** `/pricelist`
- **Rate Limit:** Cache recommended (24h)
- **Data:** USD retail and buy prices

See [`docs/API.md`](docs/API.md) for detailed API documentation.

---

## 🛡️ Security

- ✅ Row Level Security (RLS) enabled
- ✅ Service role key never exposed to client
- ✅ Environment variables for secrets
- ✅ HTTPS-only API calls
- ✅ Input validation on imports

**Important:** Never commit `.env.local` to Git!

---

## 📊 Performance

- **First Contentful Paint:** < 2s
- **Database Queries:** < 100ms
- **API Import Speed:** ~150ms per card
- **Lighthouse Score:** 90+ target

---

## 🐛 Troubleshooting

### Common Issues

**Cards not loading?**
- Check Supabase connection
- Verify RLS policies allow public read
- Ensure `is_available = TRUE`

**Import script fails?**
- Check CSV column names
- Increase delay if rate limited (DELAY_MS = 300)
- Review `failed-imports.json`

**Build fails on Vercel?**
- Check build logs
- Verify Node.js version (18+)
- Ensure all dependencies installed

👉 **Full troubleshooting:** [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#troubleshooting)

---

## 🤝 Contributing

This is a custom project for Dan's MTG community. Suggestions welcome!

Potential enhancements:
- [ ] User authentication
- [ ] Shopping cart
- [ ] Automated Facebook posting
- [ ] Price history charts
- [ ] WhatsApp integration

---

## 📄 License

MIT License - Feel free to use for your own MTG sales system!

---

## 🙏 Credits

- **Scryfall** - Card data and images (https://scryfall.com)
- **CardKingdom** - Pricing data (https://cardkingdom.com)
- **Supabase** - Database backend (https://supabase.com)
- **Next.js** - React framework (https://nextjs.org)
- **Vercel** - Hosting platform (https://vercel.com)

---

## 📞 Support

- 📖 Read the docs in `/docs`
- 🔧 Check troubleshooting section
- 💬 Contact Dan for questions

---

**Built with ❤️ for Dan's Bizarre Bazaar**  
**Version:** 1.0.0 | **Status:** ✅ Production Ready
