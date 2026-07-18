-- Staged from supabase/migration-018-facebook-export-photo-contract.sql
-- Phase 40 contract migration: remove the legacy authenticated mutation paths
-- only after the service-RPC application has deployed and passed smoke checks.

-- Phase 15 stored canonical photos at fixed legacy paths. Keep those existing
-- rows readable, but require every newly inserted or changed canonical row to
-- use an immutable, versioned path. NOT VALID skips the historical scan while
-- PostgreSQL still enforces the constraint for new/updated rows.
ALTER TABLE public.card_photos
  ADD CONSTRAINT card_photos_versioned_storage_path_check
  CHECK (
    storage_path ~ (
      '^' || user_id::text || '/' || library_card_id::text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
    )
  ) NOT VALID;

DROP POLICY IF EXISTS "owner card photos crud" ON public.card_photos;
DROP POLICY IF EXISTS "authenticated card photos select" ON public.card_photos;

CREATE POLICY "owner card photos select"
  ON public.card_photos
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.card_photos FROM anon, authenticated;
GRANT SELECT ON TABLE public.card_photos TO authenticated;

DROP POLICY IF EXISTS "owner update card photos" ON storage.objects;
DROP POLICY IF EXISTS "owner delete card photos" ON storage.objects;
