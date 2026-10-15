BEGIN;

-- Catalog refreshes are staged outside the live search set. A publish call
-- updates rows and flips the active flag in one database transaction, so a
-- failed or partial download cannot become the visible catalog.
ALTER TABLE public.card_index
  ADD COLUMN IF NOT EXISTS catalog_current boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_card_index_catalog_current
  ON public.card_index (catalog_current);

CREATE TABLE IF NOT EXISTS public.catalog_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  current_version uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  source_field text NOT NULL,
  source_url_sha256 text NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  skipped_count integer NOT NULL CHECK (skipped_count >= 0)
);

INSERT INTO public.catalog_state (
  id, current_version, completed_at, source_field, source_url_sha256, row_count, skipped_count
)
SELECT true, gen_random_uuid(), now(), 'legacy-bootstrap', '', count(*)::integer, 0
FROM public.card_index
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.catalog_refresh_staging (
  refresh_id uuid NOT NULL,
  scryfall_id uuid NOT NULL,
  name text NOT NULL,
  set_code text NOT NULL,
  set_name text,
  collector_number text NOT NULL,
  rarity text,
  colors text[] NOT NULL DEFAULT '{}',
  type_line text,
  cmc numeric(6,2),
  mana_cost text,
  image_uris jsonb,
  finishes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (refresh_id, scryfall_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_refresh_staging_refresh
  ON public.catalog_refresh_staging (refresh_id);

ALTER TABLE public.catalog_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_refresh_staging ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.publish_catalog_refresh(
  p_refresh_id uuid,
  p_source_field text,
  p_source_url_sha256 text,
  p_row_count integer,
  p_skipped_count integer
) RETURNS TABLE (published_rows integer, completed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
  v_completed_at timestamptz := now();
BEGIN
  SELECT count(*)::integer INTO v_count
  FROM public.catalog_refresh_staging
  WHERE refresh_id = p_refresh_id;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'publish_catalog_refresh: refresh % has no staged rows', p_refresh_id;
  END IF;

  IF p_row_count IS NULL OR p_row_count <> v_count THEN
    RAISE EXCEPTION 'publish_catalog_refresh: row count mismatch, expected %, staged %', p_row_count, v_count;
  END IF;

  -- Completeness policy for Scryfall default_cards. The verified 2026-09-30
  -- run accepted 109,271 rows and skipped 9,135. Require at least 100,000
  -- accepted rows and an 85% accepted-to-parsed ratio to reject a truncated or
  -- badly malformed source while preserving measured operational headroom.
  IF p_row_count < 100000 THEN
    RAISE EXCEPTION 'publish_catalog_refresh: completeness requires at least 100000 accepted rows, got %', p_row_count;
  END IF;

  IF p_skipped_count IS NULL OR p_skipped_count < 0 THEN
    RAISE EXCEPTION 'publish_catalog_refresh: skipped row count must be non-negative';
  END IF;

  IF p_row_count::numeric / (p_row_count + p_skipped_count) < 0.85 THEN
    RAISE EXCEPTION 'publish_catalog_refresh: completeness requires at least 85 percent accepted rows';
  END IF;

  UPDATE public.card_index
  SET catalog_current = false
  WHERE catalog_current = true;

  INSERT INTO public.card_index (
    scryfall_id, name, set_code, set_name, collector_number, rarity,
    colors, type_line, cmc, mana_cost, image_uris, finishes,
    catalog_current, updated_at
  )
  SELECT
    scryfall_id, name, set_code, set_name, collector_number, rarity,
    colors, type_line, cmc, mana_cost, image_uris, finishes,
    true, v_completed_at
  FROM public.catalog_refresh_staging
  WHERE refresh_id = p_refresh_id
  ON CONFLICT (scryfall_id) DO UPDATE SET
    name = EXCLUDED.name,
    set_code = EXCLUDED.set_code,
    set_name = EXCLUDED.set_name,
    collector_number = EXCLUDED.collector_number,
    rarity = EXCLUDED.rarity,
    colors = EXCLUDED.colors,
    type_line = EXCLUDED.type_line,
    cmc = EXCLUDED.cmc,
    mana_cost = EXCLUDED.mana_cost,
    image_uris = EXCLUDED.image_uris,
    finishes = EXCLUDED.finishes,
    catalog_current = true,
    updated_at = EXCLUDED.updated_at;

  UPDATE public.catalog_state
  SET current_version = p_refresh_id,
      completed_at = v_completed_at,
      source_field = p_source_field,
      source_url_sha256 = p_source_url_sha256,
      row_count = v_count,
      skipped_count = p_skipped_count
  WHERE id = true;

  DELETE FROM public.catalog_refresh_staging
  WHERE refresh_id = p_refresh_id;

  RETURN QUERY SELECT v_count, v_completed_at;
END;
$$;

REVOKE ALL ON TABLE public.catalog_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.catalog_refresh_staging FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_catalog_refresh(uuid, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_catalog_refresh(uuid, text, text, integer, integer)
  TO service_role;

-- Seeded local-UAT rows are the initial known-good catalog.
UPDATE public.card_index
SET catalog_current = true
WHERE catalog_current IS NULL;

COMMIT;
