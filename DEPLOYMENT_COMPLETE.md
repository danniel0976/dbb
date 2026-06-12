# ✅ DBB Deployment Complete!

## 🎉 Your Site is LIVE!

**Production URL:** https://nextjs-oin5wztup-chippyandluke.vercel.app  
**GitHub Repo:** https://github.com/danniel0976/dbb  
**Vercel Dashboard:** https://vercel.com/chippyandluke/nextjs

---

## ✅ What's Done

1. ✅ **Code deployed to Vercel** - Live and accessible
2. ✅ **GitHub repo created** - Auto-deploy enabled
3. ✅ **Environment variables set** - Supabase configured
4. ✅ **Git integration connected** - Push to main = auto deploy

---

## 🔧 What You Need to Do (3 tasks)

### Task 1: Add Custom Domain in Vercel (2 min)

1. Go to: https://vercel.com/chippyandluke/nextjs/settings/domains
2. Click **Add Domain**
3. Enter: `dbb.lovelikenotomorrow.com`
4. Click **Add**

Then update your DNS at your domain registrar:

```
Type: CNAME
Name: dbb
Value: cname.vercel-dns.com
TTL: Automatic (or 3600)
```

Wait 5-10 minutes for SSL certificate to generate automatically.

---

### Task 2: Run Supabase Schema (5 min)

The database schema needs to be created before you can import cards:

1. Go to: https://supabase.com/dashboard/project/mnyhpwqskzadkplnhbrx/sql
2. Click **New Query**
3. Open file: `/root/.openclaw/workspace/dbb/supabase/schema.sql`
4. Copy ALL contents
5. Paste into SQL Editor
6. Click **Run** (or Ctrl+Enter)

Verify it worked:
- Go to Table Editor
- Select schema: `dbb`
- You should see 3 tables: `cards`, `price_history`, `exchange_rates`

---

### Task 3: Update Service Role Key (1 min)

I used the anon key as placeholder. Get the real service role key:

1. Go to: https://supabase.com/dashboard/project/mnyhpwqskzadkplnhbrx/settings/api
2. Copy **Service Role Key** (⚠️ NOT the anon/public key!)
3. Go to: https://vercel.com/chippyandluke/nextjs/settings/environment-variables
4. Edit `SUPABASE_SERVICE_ROLE_KEY`
5. Paste the real key
6. Click **Save**
7. Redeploy: Go to https://vercel.com/chippyandluke/nextjs/deployments and click **Redeploy** on latest

---

## 📥 Import Your Collection

Once schema is set up:

```bash
cd /root/.openclaw/workspace/dbb
node scripts/import-collection.js my-collection.csv
```

Your CSV should have columns:
```csv
Card Name,Set,Collector No,Foil,Condition
Roaming Throne,LCI,258,false,NM
```

---

## 🔄 GitHub → Vercel Workflow

From now on, every push to `main` branch auto-deploys:

```bash
cd /root/.openclaw/workspace/dbb
# Make changes...
git add .
git commit -m "Updated something"
git push origin main
# Vercel auto-deploys!
```

Check deployment status: https://vercel.com/chippyandluke/nextjs/activity

---

## 📊 Current Status

| Item | Status | Notes |
|------|--------|-------|
| Code Deployed | ✅ Live | https://nextjs-oin5wztup-chippyandluke.vercel.app |
| GitHub Repo | ✅ Created | https://github.com/danniel0976/dbb |
| Auto-Deploy | ✅ Enabled | Push to main = auto deploy |
| Custom Domain | ⏳ Pending | Add in Vercel + update DNS |
| Supabase Schema | ⏳ Pending | Run schema.sql |
| Service Role Key | ⏳ Pending | Update in Vercel env vars |
| Collection Import | ⏳ Pending | After schema is ready |

---

## 🎯 Quick Links

- **Live Site:** https://nextjs-oin5wztup-chippyandluke.vercel.app
- **Vercel Dashboard:** https://vercel.com/chippyandluke/nextjs
- **GitHub Repo:** https://github.com/danniel0976/dbb
- **Supabase Dashboard:** https://supabase.com/dashboard/project/mnyhpwqskzadkplnhbrx
- **Add Domain:** https://vercel.com/chippyandluke/nextjs/settings/domains
- **Env Variables:** https://vercel.com/chippyandluke/nextjs/settings/environment-variables

---

## 🆘 Need Help?

All documentation is in `/root/.openclaw/workspace/dbb/docs/`:
- `QUICKSTART.md` - Setup guide
- `README.md` - Full documentation
- `DEPLOYMENT.md` - Deployment details
- `API.md` - API integration docs

Just ask Chippy! 🐕
