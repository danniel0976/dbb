-- Phase 14: Listing lifecycle — expires_at column + expiry index
-- Apply in Supabase SQL Editor (project mnyhpwqskzadkplnhbrx)

-- Step 1: Add expires_at as nullable first so backfill can run
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Step 2: Backfill existing rows — treat all as if they had a 24h duration
UPDATE public.listings
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

-- Step 3: Enforce NOT NULL now that all rows have a value
ALTER TABLE public.listings
  ALTER COLUMN expires_at SET NOT NULL;

-- Step 4: Composite index covering the two most common query shapes:
--   WHERE status = 'active' AND expires_at > now()   (bazaar browse, cart check)
--   WHERE status = 'active' AND expires_at < now()   (expiry sweep)
CREATE INDEX IF NOT EXISTS idx_listings_status_expires
  ON public.listings (status, expires_at);
