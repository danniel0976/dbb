-- Phase 24: Claim Sales
CREATE TABLE IF NOT EXISTS public.claim_sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  set_code        text,
  duration_hours  integer NOT NULL CHECK (duration_hours BETWEEN 1 AND 24),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  delivery_option text NOT NULL CHECK (delivery_option IN ('pickup','shipping','both')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claim_sales_user ON public.claim_sales(user_id);
CREATE INDEX IF NOT EXISTS idx_claim_sales_status_expires ON public.claim_sales(status, expires_at);
ALTER TABLE public.claim_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner claim_sales crud" ON public.claim_sales FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "authenticated claim_sales select" ON public.claim_sales FOR SELECT USING (auth.role() = 'authenticated');

-- Link listings to claim sales
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS claim_sale_id uuid REFERENCES public.claim_sales(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_listings_claim_sale ON public.listings(claim_sale_id) WHERE claim_sale_id IS NOT NULL;

-- Follows (claim sale follows + user follows)
CREATE TABLE IF NOT EXISTS public.follows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followee_id   uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  claim_sale_id uuid REFERENCES public.claim_sales(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (followee_id IS NOT NULL OR claim_sale_id IS NOT NULL),
  UNIQUE(follower_id, followee_id),
  UNIQUE(follower_id, claim_sale_id)
);
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner follows crud" ON public.follows FOR ALL USING (auth.uid() = follower_id) WITH CHECK (auth.uid() = follower_id);
CREATE POLICY "authenticated follows select" ON public.follows FOR SELECT USING (auth.role() = 'authenticated');