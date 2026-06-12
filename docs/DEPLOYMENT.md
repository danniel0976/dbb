# DBB Deployment Checklist

## Pre-Deployment

### 1. Supabase Setup

- [ ] Create Supabase project at https://mnyhpwqskzadkplnhbrx.supabase.co
- [ ] Create `dbb` schema by running `supabase/schema.sql` in SQL Editor
- [ ] Verify tables created: `cards`, `price_history`, `exchange_rates`
- [ ] Test RLS policies with anon user
- [ ] Note down API keys from Project Settings > API:
  - Project URL
  - Anon/Public Key
  - Service Role Key (keep secret!)

### 2. Environment Variables

Create `.env.local` in `nextjs/` directory:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://mnyhpwqskzadkplnhbrx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
USD_MYR_RATE=4.70
DEFAULT_MULTIPLIER=2.8
NEXT_PUBLIC_SITE_URL=https://dbb.lovelikenotomorrow.com
```

### 3. Collection Import

- [ ] Export your ManaBox collection to CSV
- [ ] Verify CSV columns match expected format
- [ ] Run import script: `node scripts/import-collection.js <path>.csv`
- [ ] Review `failed-imports.json` if any errors
- [ ] Verify cards appear in Supabase Dashboard > Table Editor

### 4. Local Testing

- [ ] Install dependencies: `npm install`
- [ ] Run dev server: `npm run dev`
- [ ] Test on localhost:3000
- [ ] Verify card loading and filtering works
- [ ] Test caption copy functionality
- [ ] Check mobile responsiveness (DevTools)

## Vercel Deployment

### 1. Git Setup

```bash
cd nextjs
git init
git add .
git commit -m "Initial DBB deployment"
git remote add origin <your-github-repo-url>
git push -u origin main
```

### 2. Vercel Project Setup

1. Go to https://vercel.com/new
2. Import your Git repository
3. Configure project:
   - **Framework Preset:** Next.js
   - **Root Directory:** `nextjs` (if repo root is `dbb/`)
   - **Build Command:** `npm run build`
   - **Output Directory:** `.next`
   - **Install Command:** `npm install`

### 3. Environment Variables (Vercel)

In Vercel Dashboard > Project Settings > Environment Variables:

| Variable | Value | Environment |
|----------|-------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase URL | Production, Preview, Development |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key | Production, Preview, Development |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key | Production only ⚠️ |
| `USD_MYR_RATE` | 4.70 | Production, Preview |
| `NEXT_PUBLIC_SITE_URL` | https://dbb.lovelikenotomorrow.com | Production |

**Security Note:** Never expose `SUPABASE_SERVICE_ROLE_KEY` to client-side!

### 4. Deploy

- [ ] Click **Deploy** in Vercel
- [ ] Wait for build to complete (~2-5 minutes)
- [ ] Click deployment URL to test
- [ ] Check deployment logs for errors

### 5. Custom Domain

1. In Vercel > Project Settings > Domains
2. Add domain: `dbb.lovelikenotomorrow.com`
3. Update DNS records:
   ```
   Type: CNAME
   Name: dbb
   Value: cname.vercel-dns.com
   TTL: Auto
   ```
4. Wait for DNS propagation (up to 48 hours)
5. Enable HTTPS (automatic via Vercel)

## Post-Deployment

### 1. Testing

- [ ] Load production site on desktop
- [ ] Load production site on mobile
- [ ] Test all filters
- [ ] Open card detail modal
- [ ] Copy caption to clipboard
- [ ] Test on different browsers (Chrome, Safari, Firefox)

### 2. Performance

- [ ] Run Lighthouse audit (Chrome DevTools)
- [ ] Check Core Web Vitals in Vercel Analytics
- [ ] Optimize images if needed
- [ ] Enable Vercel Analytics

### 3. Monitoring

- [ ] Set up Supabase query monitoring
- [ ] Enable Vercel Error Monitoring
- [ ] Set up uptime monitoring (e.g., UptimeRobot)

### 4. Facebook Integration

- [ ] Create sample Facebook post with caption
- [ ] Test on mobile Facebook app
- [ ] Verify image quality in posts
- [ ] Share link in Facebook group

## Maintenance Tasks

### Weekly

- [ ] Check for new card arrivals in collection
- [ ] Update exchange rate if needed (USD/MYR fluctuates)
- [ ] Review failed Facebook claims

### Monthly

- [ ] Refresh CardKingdom prices (re-run import script)
- [ ] Clean up sold cards (set `is_available = FALSE`)
- [ ] Review analytics and user feedback
- [ ] Backup Supabase database

### Quarterly

- [ ] Update dependencies: `npm update`
- [ ] Review and optimize database queries
- [ ] Check for Scryfall API changes
- [ ] Security audit of dependencies

## Troubleshooting

### Common Issues

#### Cards Not Loading

```sql
-- Check if cards exist
SELECT COUNT(*) FROM dbb.cards WHERE is_available = TRUE;

-- Check RLS policies
SELECT * FROM pg_policies WHERE schemaname = 'dbb';

-- Test anon access
SET ROLE anon;
SELECT * FROM dbb.available_cards LIMIT 1;
```

#### Import Script Errors

- **Rate Limit Errors:** Increase `DELAY_MS` to 200-300ms
- **CSV Parse Errors:** Check column names and encoding (UTF-8)
- **Supabase Connection:** Verify service role key is correct

#### Build Failures on Vercel

- Check build logs for missing dependencies
- Verify `package.json` has all required packages
- Ensure Node.js version compatibility (18+)

### Support Contacts

- **Scryfall API:** https://scryfall.com/contact
- **CardKingdom:** https://www.cardkingdom.com/contact-us
- **Supabase:** https://supabase.com/docs/getting-started
- **Vercel:** https://vercel.com/docs/support

## Rollback Procedure

If deployment breaks:

1. Go to Vercel > Deployments
2. Find last working deployment
3. Click **...** menu
4. Select **Promote to Production**
5. Fix issues in development branch
6. Redeploy when ready

---

**Last Updated:** June 2026  
**Version:** 1.0.0
