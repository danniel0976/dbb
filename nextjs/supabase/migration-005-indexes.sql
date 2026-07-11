-- Migration 005: Performance indexes for multi-user library queries
-- Dan applies manually via Supabase dashboard → SQL editor.
-- Safe to run multiple times (CREATE INDEX IF NOT EXISTS).

-- Primary access pattern: list library cards for a user, optionally in a binder,
-- ordered by date_added DESC. The compound index covers the WHERE + ORDER BY.
CREATE INDEX IF NOT EXISTS idx_library_cards_user_binder_date
  ON library_cards (user_id, binder_id, date_added DESC);

-- For queries that filter by user only (no binder), e.g. profile/value total.
-- user_id alone may already be covered by RLS index; added explicitly for safety.
CREATE INDEX IF NOT EXISTS idx_library_cards_user_id
  ON library_cards (user_id);

-- binders access pattern: list by user ordered by created_at.
CREATE INDEX IF NOT EXISTS idx_binders_user_created
  ON binders (user_id, created_at);

-- card_index filters used in advanced search — covering index for the most common
-- combination of rarity + type_line lookups done via the joined query.
CREATE INDEX IF NOT EXISTS idx_card_index_rarity
  ON card_index (rarity);

CREATE INDEX IF NOT EXISTS idx_card_index_set_code
  ON card_index (set_code);

-- Note: ilike '%...%' on name/type_line cannot use btree indexes efficiently.
-- If full-text search performance becomes a bottleneck, add:
--   CREATE INDEX ON card_index USING gin(to_tsvector('english', name));
--   CREATE INDEX ON card_index USING gin(to_tsvector('english', type_line));
-- and rewrite the ilike filters to use websearch_to_tsquery.
