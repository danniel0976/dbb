-- migration-011-rpc-binder-validation.sql
-- Dan applies manually in Supabase SQL Editor (project mnyhpwqskzadkplnhbrx).
--
-- Purpose: Phase 17 — add binder ownership validation to import_library_cards.
--   The RPC previously accepted any binder_id without checking whether it belongs
--   to p_user_id. A caller passing the wrong user's binder would insert rows into
--   that binder unchecked (the FK only verifies the binder exists, not that the user
--   owns it). This rewrite adds an explicit ownership check and raises an informative
--   error if the binder doesn't belong to the importing user.
--
-- Backwards-compatible: signature and return type are unchanged.
-- Safe to re-run: uses CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION public.import_library_cards(
  p_user_id uuid,
  p_binder_id uuid,
  p_rows jsonb
) RETURNS TABLE (inserted int, merged int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_binder_owner uuid;
BEGIN
  -- Reject null binder — never fall back to a default
  IF p_binder_id IS NULL THEN
    RAISE EXCEPTION 'import_library_cards: p_binder_id must not be null. Every import requires an explicit binder.';
  END IF;

  -- Verify binder belongs to the importing user
  SELECT user_id INTO v_binder_owner
  FROM public.binders
  WHERE id = p_binder_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'import_library_cards: binder % does not exist.', p_binder_id;
  END IF;

  IF v_binder_owner <> p_user_id THEN
    RAISE EXCEPTION 'import_library_cards: binder % does not belong to user %.', p_binder_id, p_user_id;
  END IF;

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

-- Keep the same REVOKE — only service role can call this.
REVOKE EXECUTE ON FUNCTION public.import_library_cards(uuid, uuid, jsonb)
  FROM anon, authenticated;
