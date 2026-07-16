-- Phase 40 expand migration: immutable condition-photo promotion and Facebook
-- export snapshots. This migration intentionally leaves the Phase 15 direct
-- mutation policies in place during the application deployment. Migration 018
-- contracts those legacy permissions after the new service-RPC application is
-- live and verified.

-- Composite ownership/version keys let the snapshot prove that its card, owner,
-- and photo path all refer to the same current canonical condition photo.
ALTER TABLE public.library_cards
  ADD CONSTRAINT library_cards_id_user_unique UNIQUE (id, user_id);

ALTER TABLE public.card_photos
  ADD CONSTRAINT card_photos_card_user_path_unique
  UNIQUE (library_card_id, user_id, storage_path);

CREATE TABLE public.fb_export_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  library_card_id       uuid NOT NULL UNIQUE,
  multiplier            numeric NOT NULL CHECK (multiplier > 0),
  ckd_usd_snapshot      numeric NOT NULL CHECK (ckd_usd_snapshot >= 0),
  myr_price_snapshot    numeric NOT NULL CHECK (myr_price_snapshot >= 0),
  generation_id         uuid NOT NULL,
  photo_storage_path    text NOT NULL,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fb_export_snapshot_card_owner_fk
    FOREIGN KEY (library_card_id, user_id)
    REFERENCES public.library_cards(id, user_id) ON DELETE CASCADE,
  CONSTRAINT fb_export_snapshot_canonical_photo_fk
    FOREIGN KEY (library_card_id, user_id, photo_storage_path)
    REFERENCES public.card_photos(library_card_id, user_id, storage_path)
    ON DELETE CASCADE
);

CREATE INDEX idx_fb_export_snapshots_user
  ON public.fb_export_snapshots(user_id);

ALTER TABLE public.fb_export_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner facebook export snapshots select"
  ON public.fb_export_snapshots
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Snapshot rows are generated values, not user-authored records. Authenticated
-- owners may read them, while the service-only RPCs below remain the only
-- insert/update/delete authority (including invalidation).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.fb_export_snapshots FROM anon, authenticated;
GRANT SELECT ON TABLE public.fb_export_snapshots TO authenticated;

CREATE OR REPLACE FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.fb_export_snapshots
  WHERE library_card_id = NEW.id
    AND user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change() FROM anon;
REVOKE ALL ON FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change() FROM authenticated;

CREATE TRIGGER invalidate_fb_export_snapshot_on_card_details_change
  AFTER UPDATE OF condition, foil ON public.library_cards
  FOR EACH ROW
  WHEN (
    OLD.condition IS DISTINCT FROM NEW.condition
    OR OLD.foil IS DISTINCT FROM NEW.foil
  )
  EXECUTE FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change();

CREATE OR REPLACE FUNCTION public.promote_card_photo(
  p_user_id uuid,
  p_library_card_id uuid,
  p_storage_path text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous_path text;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  PERFORM 1
  FROM public.library_cards
  WHERE id = p_library_card_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'library card not found';
  END IF;

  IF p_storage_path !~ (
    '^' || p_user_id::text || '/' || p_library_card_id::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
  ) THEN
    RAISE EXCEPTION 'invalid photo candidate path';
  END IF;

  SELECT storage_path
  INTO v_previous_path
  FROM public.card_photos
  WHERE library_card_id = p_library_card_id
  FOR UPDATE;

  DELETE FROM public.fb_export_snapshots
  WHERE library_card_id = p_library_card_id
    AND user_id = p_user_id;

  INSERT INTO public.card_photos (user_id, library_card_id, storage_path)
  VALUES (p_user_id, p_library_card_id, p_storage_path)
  ON CONFLICT (library_card_id) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        storage_path = EXCLUDED.storage_path,
        created_at = now();

  RETURN v_previous_path;
END;
$$;

REVOKE ALL ON FUNCTION public.promote_card_photo(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_card_photo(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_card_photo(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.update_library_card_and_invalidate_export(
  p_user_id uuid,
  p_library_card_id uuid,
  p_updates jsonb
)
RETURNS public.library_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card public.library_cards;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  IF p_updates - ARRAY['quantity', 'condition', 'foil', 'starred'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unsupported library card update';
  END IF;

  UPDATE public.library_cards
  SET quantity = CASE WHEN p_updates ? 'quantity' THEN (p_updates->>'quantity')::integer ELSE quantity END,
      condition = CASE WHEN p_updates ? 'condition' THEN p_updates->>'condition' ELSE condition END,
      foil = CASE WHEN p_updates ? 'foil' THEN p_updates->>'foil' ELSE foil END,
      starred = CASE WHEN p_updates ? 'starred' THEN (p_updates->>'starred')::boolean ELSE starred END
  WHERE id = p_library_card_id
    AND user_id = p_user_id
  RETURNING * INTO v_card;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'library card not found';
  END IF;

  RETURN v_card;
END;
$$;

REVOKE ALL ON FUNCTION public.update_library_card_and_invalidate_export(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_library_card_and_invalidate_export(uuid, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_library_card_and_invalidate_export(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_card_photo_and_invalidate_export(
  p_user_id uuid,
  p_library_card_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_storage_path text;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  PERFORM 1 FROM public.library_cards
  WHERE id = p_library_card_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'library card not found'; END IF;

  DELETE FROM public.fb_export_snapshots
  WHERE library_card_id = p_library_card_id AND user_id = p_user_id;

  DELETE FROM public.card_photos
  WHERE library_card_id = p_library_card_id AND user_id = p_user_id
  RETURNING storage_path INTO v_storage_path;

  RETURN v_storage_path;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_card_photo_and_invalidate_export(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_card_photo_and_invalidate_export(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.delete_card_photo_and_invalidate_export(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.save_fb_export_snapshot(
  p_user_id uuid,
  p_library_card_id uuid,
  p_multiplier numeric,
  p_ckd_usd numeric,
  p_myr_price numeric,
  p_generation_id uuid,
  p_photo_storage_path text,
  p_condition text,
  p_foil text
)
RETURNS public.fb_export_snapshots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card public.library_cards;
  v_snapshot public.fb_export_snapshots;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  SELECT * INTO v_card
  FROM public.library_cards
  WHERE id = p_library_card_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'library card not found'; END IF;
  IF v_card.condition IS DISTINCT FROM p_condition OR v_card.foil IS DISTINCT FROM p_foil THEN
    RAISE EXCEPTION 'card details changed during generation';
  END IF;

  PERFORM 1
  FROM public.card_photos
  WHERE library_card_id = p_library_card_id
    AND user_id = p_user_id
    AND storage_path = p_photo_storage_path
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'condition photo changed during generation'; END IF;

  INSERT INTO public.fb_export_snapshots
    (user_id, library_card_id, multiplier, ckd_usd_snapshot, myr_price_snapshot,
     generation_id, photo_storage_path, generated_at)
  VALUES
    (p_user_id, p_library_card_id, p_multiplier, p_ckd_usd, p_myr_price,
     p_generation_id, p_photo_storage_path, now())
  ON CONFLICT (library_card_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    multiplier = EXCLUDED.multiplier,
    ckd_usd_snapshot = EXCLUDED.ckd_usd_snapshot,
    myr_price_snapshot = EXCLUDED.myr_price_snapshot,
    generation_id = EXCLUDED.generation_id,
    photo_storage_path = EXCLUDED.photo_storage_path,
    generated_at = EXCLUDED.generated_at
  RETURNING * INTO v_snapshot;

  RETURN v_snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.save_fb_export_snapshot(uuid, uuid, numeric, numeric, numeric, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_fb_export_snapshot(uuid, uuid, numeric, numeric, numeric, uuid, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.save_fb_export_snapshot(uuid, uuid, numeric, numeric, numeric, uuid, text, text, text) TO service_role;
