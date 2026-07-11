-- migration-005-indexes.sql — Phase 9 performance indexes
-- (Recreated 2026-07-11: Phase 9's worker documented this file in its report
-- but never committed it. Contents per the Phase 9 completion report.)
-- Safe to run at any time — IF NOT EXISTS throughout. Apply in Supabase SQL Editor.

-- Library listing: main query path is (user, binder, newest first)
CREATE INDEX IF NOT EXISTS idx_library_cards_user_binder_added
  ON public.library_cards (user_id, binder_id, date_added DESC);

-- Binder rail ordering
CREATE INDEX IF NOT EXISTS idx_binders_user_created
  ON public.binders (user_id, created_at);

-- Advanced-search filters on the card index
CREATE INDEX IF NOT EXISTS idx_card_index_rarity
  ON public.card_index (rarity);

CREATE INDEX IF NOT EXISTS idx_card_index_set_code
  ON public.card_index (set_code);
