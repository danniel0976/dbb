-- ============================================================
-- Phase 15: Card Photos + Seller Trust
-- Apply in Supabase SQL Editor as postgres role
-- ============================================================

-- 1. card_photos table -------------------------------------------
CREATE TABLE IF NOT EXISTS public.card_photos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  library_card_id  uuid NOT NULL UNIQUE REFERENCES public.library_cards(id) ON DELETE CASCADE,
  storage_path     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_photos_user     ON public.card_photos(user_id);
CREATE INDEX IF NOT EXISTS idx_card_photos_lc       ON public.card_photos(library_card_id);

-- 2. RLS ---------------------------------------------------------
ALTER TABLE public.card_photos ENABLE ROW LEVEL SECURITY;

-- Owner can insert / update / delete their own photo rows
CREATE POLICY "owner card photos crud"
  ON public.card_photos
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Any authenticated user can select metadata (not the storage object — that requires a signed URL)
CREATE POLICY "authenticated card photos select"
  ON public.card_photos
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================================
-- STORAGE: Supabase Storage bucket + policies
-- ============================================================
-- NOTE: Storage bucket creation via SQL requires the storage extension.
-- If the INSERT below fails, create the bucket manually in the Supabase
-- Dashboard → Storage → New bucket: name="card-photos", private (unchecked Public).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'card-photos',
  'card-photos',
  false,
  5242880,                  -- 5 MB max per object
  ARRAY['image/jpeg','image/jpg','image/png','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies for objects in card-photos bucket
-- Owner can insert (upload) their own photos
CREATE POLICY "owner upload card photos"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'card-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Owner can update (overwrite) their own photos
CREATE POLICY "owner update card photos"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'card-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Owner can delete their own photos
CREATE POLICY "owner delete card photos"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'card-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- No direct SELECT on storage objects — all reads go through server-generated signed URLs.
-- Service role bypasses RLS and can generate signed URLs server-side.

-- ============================================================
-- DASHBOARD INSTRUCTIONS (for Dan)
-- ============================================================
-- After running this SQL:
-- 1. Go to Supabase Dashboard → Storage
--    - Verify "card-photos" bucket exists and is PRIVATE (not public)
--    - If it doesn't appear, click "New bucket":
--        Name: card-photos
--        Public bucket: OFF (unchecked)
--        File size limit: 5 MB
--        Allowed MIME types: image/jpeg, image/png, image/webp
--
-- 2. The storage object RLS policies above are applied automatically.
--    Verify them at Storage → Policies → card-photos bucket.
--
-- 3. No other dashboard actions needed — the Next.js app handles
--    uploads/signed URLs entirely server-side via the service role.
-- ============================================================
