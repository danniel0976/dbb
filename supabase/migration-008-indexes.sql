-- migration-008-indexes.sql
-- Dan applies manually in Supabase SQL Editor (project mnyhpwqskzadkplnhbrx).
-- Safe to re-run: uses CREATE INDEX IF NOT EXISTS and CREATE OR REPLACE FUNCTION.
--
-- Purpose: Phase 13 database optimization pass.
--   1. pg_trgm GIN indexes on card_index — fixes ILIKE '%query%' catalog searches
--      (105k rows; without this, every search is a full seqscan).
--   2. Listings indexes — covers bazaar browsing (status + date sort, seller lookup).
--   3. Rewrite import_library_cards RPC — replaces a PL/pgSQL row-by-row loop with
--      a single bulk INSERT ... ON CONFLICT, order-of-magnitude faster for large imports.

-- ── 1. pg_trgm extension ──────────────────────────────────────────────────────
-- Required for gin_trgm_ops indexes. Safe to enable even if already present.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 2. GIN trigram indexes on card_index ─────────────────────────────────────
-- These make ILIKE '%query%' (used in catalog/search and advanced-search type_line
-- filters) use an index scan instead of a sequential scan over 100k+ rows.
-- Note: idx_card_index_name (full-text) and idx_card_index_name_trgm (btree
-- text_pattern_ops, prefix-only) were created in earlier migrations; the GIN
-- trigram indexes below are ADDITIVE and handle substring matches.

CREATE INDEX IF NOT EXISTS idx_card_index_name_gin_trgm
  ON public.card_index USING gin(name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_card_index_type_line_gin_trgm
  ON public.card_index USING gin(type_line gin_trgm_ops);

-- ── 3. library_cards (user_id, date_added DESC) ──────────────────────────────
-- The existing compound index (user_id, binder_id, date_added DESC) serves the
-- binder-scoped query efficiently.  For the "all cards" view (no binder filter),
-- ORDER BY date_added DESC with only a user_id predicate can't use that index's
-- sort order (binder_id is interleaved), forcing a post-scan re-sort of ~1.8k rows.
-- This two-column index eliminates the re-sort.
CREATE INDEX IF NOT EXISTS idx_library_cards_user_date
  ON public.library_cards (user_id, date_added DESC);

-- ── 4. Listings indexes ───────────────────────────────────────────────────────
-- Covers the dominant bazaar query: WHERE status = 'active' ORDER BY created_at DESC.
-- The DESC storage matches the default sort order so Postgres can avoid a re-sort.
CREATE INDEX IF NOT EXISTS idx_listings_status_created
  ON public.listings (status, created_at DESC);

-- Covers per-user listing queries (CardDetailModal "is this card listed?" check,
-- and the seller-lookup step in the bazaar route).
CREATE INDEX IF NOT EXISTS idx_listings_user_id
  ON public.listings (user_id);

-- ── 4. Bulk import_library_cards RPC ─────────────────────────────────────────
-- Replaces the original PL/pgSQL row-by-row loop (N individual INSERTs) with a
-- single INSERT ... SELECT ... ON CONFLICT that processes the entire JSON array
-- atomically.  xmax = 0 in the RETURNING clause correctly identifies fresh inserts
-- vs conflict-updates within a single INSERT statement.
--
-- Return signature is unchanged: TABLE(inserted int, merged int).
CREATE OR REPLACE FUNCTION public.import_library_cards(
  p_user_id uuid,
  p_binder_id uuid,
  p_rows jsonb
) RETURNS TABLE (inserted int, merged int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH upserted AS (
    INSERT INTO public.library_cards
      (user_id, binder_id, scryfall_id, quantity, foil, condition, language,
       purchase_price, purchase_currency, date_added)
    SELECT
      p_user_id,
      p_binder_id,
      (r.value->>'scryfall_id')::uuid,
      COALESCE((r.value->>'quantity')::int, 1),
      COALESCE(r.value->>'foil', 'normal'),
      COALESCE(r.value->>'condition', 'NM'),
      COALESCE(r.value->>'language', 'en'),
      NULLIF(r.value->>'purchase_price', '')::numeric,
      r.value->>'purchase_currency',
      COALESCE((r.value->>'date_added')::timestamptz, now())
    FROM jsonb_array_elements(p_rows) AS r(value)
    ON CONFLICT (user_id, binder_id, scryfall_id, foil, condition, language)
    DO UPDATE SET
      quantity = public.library_cards.quantity + EXCLUDED.quantity
    RETURNING (xmax = 0) AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::int   AS inserted,
    COUNT(*) FILTER (WHERE NOT is_insert)::int AS merged
  FROM upserted;
END $$;

-- Keep the same REVOKE so anon/authenticated cannot call this directly —
-- only the server-side service role can invoke it.
REVOKE EXECUTE ON FUNCTION public.import_library_cards(uuid, uuid, jsonb)
  FROM anon, authenticated;
