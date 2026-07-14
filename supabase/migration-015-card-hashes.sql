-- migration-015: Card image hashes for perceptual matching
-- Stores pHash (perceptual hash) values for card images so captured photos
-- can be matched against the catalog by image similarity instead of OCR.

CREATE TABLE IF NOT EXISTS public.card_hashes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scryfall_id text NOT NULL,
  phash bigint NOT NULL,
  image_uri text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(scryfall_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_card_hashes_scryfall_id ON public.card_hashes(scryfall_id);
CREATE INDEX IF NOT EXISTS idx_card_hashes_phash ON public.card_hashes(phash);

-- RLS: anyone authenticated can read (needed for match endpoint)
-- Only service role can write (hash build script uses service role)
ALTER TABLE public.card_hashes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "card_hashes_read_authenticated" ON public.card_hashes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "card_hashes_read_anon" ON public.card_hashes
  FOR SELECT TO anon USING (true);

COMMENT ON TABLE public.card_hashes IS 'Perceptual hash index for card image matching. Populated by scripts/build-card-hashes.mjs.';