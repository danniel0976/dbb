BEGIN;

-- Rollout: DB first, then metadata-aware importer + application code. Refresh
-- default_cards after deployment; old rows remain NULL until atomic publish.
-- No table ACL/RLS changes, no indexes, no rewrite/backfill of existing rows.
ALTER TABLE public.card_index
  ADD COLUMN IF NOT EXISTS lang text,
  ADD COLUMN IF NOT EXISTS oracle_id uuid,
  ADD COLUMN IF NOT EXISTS illustration_id uuid,
  ADD COLUMN IF NOT EXISTS released_at date,
  ADD COLUMN IF NOT EXISTS frame text,
  ADD COLUMN IF NOT EXISTS frame_effects text[],
  ADD COLUMN IF NOT EXISTS promo_types text[],
  ADD COLUMN IF NOT EXISTS border_color text,
  ADD COLUMN IF NOT EXISTS has_face_images boolean,
  ADD COLUMN IF NOT EXISTS face_illustration_ids uuid[],
  ADD COLUMN IF NOT EXISTS promo boolean,
  ADD COLUMN IF NOT EXISTS set_type text,
  ADD COLUMN IF NOT EXISTS layout text,
  ADD COLUMN IF NOT EXISTS games text[];

ALTER TABLE public.catalog_refresh_staging
  ADD COLUMN IF NOT EXISTS lang text,
  ADD COLUMN IF NOT EXISTS oracle_id uuid,
  ADD COLUMN IF NOT EXISTS illustration_id uuid,
  ADD COLUMN IF NOT EXISTS released_at date,
  ADD COLUMN IF NOT EXISTS frame text,
  ADD COLUMN IF NOT EXISTS frame_effects text[],
  ADD COLUMN IF NOT EXISTS promo_types text[],
  ADD COLUMN IF NOT EXISTS border_color text,
  ADD COLUMN IF NOT EXISTS has_face_images boolean,
  ADD COLUMN IF NOT EXISTS face_illustration_ids uuid[],
  ADD COLUMN IF NOT EXISTS promo boolean,
  ADD COLUMN IF NOT EXISTS set_type text,
  ADD COLUMN IF NOT EXISTS layout text,
  ADD COLUMN IF NOT EXISTS games text[];

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
    lang, oracle_id, illustration_id, released_at, frame, frame_effects, promo_types, border_color, has_face_images, face_illustration_ids, promo, set_type, layout, games,
    catalog_current, updated_at
  )
  SELECT
    scryfall_id, name, set_code, set_name, collector_number, rarity,
    colors, type_line, cmc, mana_cost, image_uris, finishes,
    lang, oracle_id, illustration_id, released_at, frame, frame_effects, promo_types, border_color, has_face_images, face_illustration_ids, promo, set_type, layout, games,
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
    lang = EXCLUDED.lang,
    oracle_id = EXCLUDED.oracle_id,
    illustration_id = EXCLUDED.illustration_id,
    released_at = EXCLUDED.released_at,
    frame = EXCLUDED.frame,
    frame_effects = EXCLUDED.frame_effects,
    promo_types = EXCLUDED.promo_types,
    border_color = EXCLUDED.border_color,
    has_face_images = EXCLUDED.has_face_images,
    face_illustration_ids = EXCLUDED.face_illustration_ids,
    promo = EXCLUDED.promo,
    set_type = EXCLUDED.set_type,
    layout = EXCLUDED.layout,
    games = EXCLUDED.games,
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

REVOKE ALL ON FUNCTION public.publish_catalog_refresh(uuid, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_catalog_refresh(uuid, text, text, integer, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
