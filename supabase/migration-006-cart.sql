-- migration-006-cart.sql — Phase 11 cart table
-- (Recreated 2026-07-11: Phase 11's worker shipped the cart API/UI but never
-- committed this migration file. Schema per the Phase 11 spec + cart route code.)
-- Apply in Supabase SQL Editor. The cart UI/API is already deployed and
-- degrades gracefully until this runs.

CREATE TABLE IF NOT EXISTS public.cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_user ON public.cart_items (user_id);

ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;

-- Owners manage only their own cart rows.
DROP POLICY IF EXISTS cart_items_select_own ON public.cart_items;
CREATE POLICY cart_items_select_own ON public.cart_items
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS cart_items_insert_own ON public.cart_items;
CREATE POLICY cart_items_insert_own ON public.cart_items
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS cart_items_delete_own ON public.cart_items;
CREATE POLICY cart_items_delete_own ON public.cart_items
  FOR DELETE USING (auth.uid() = user_id);
