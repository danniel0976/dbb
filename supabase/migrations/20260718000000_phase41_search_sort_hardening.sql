-- Phase 41: canonical rarity ordering and authenticated catalog-search plan.
-- Design only here; apply only through the approved migration gate.

ALTER TABLE public.card_index
  ADD COLUMN rarity_rank smallint
  GENERATED ALWAYS AS (
    CASE rarity
      WHEN 'common'   THEN 10::smallint
      WHEN 'uncommon' THEN 20::smallint
      WHEN 'rare'     THEN 30::smallint
      WHEN 'mythic'   THEN 40::smallint
      ELSE NULL::smallint
    END
  ) STORED;

COMMENT ON COLUMN public.card_index.rarity_rank IS
  'Canonical C/U/R/M order. special, bonus, and unknown rarities remain NULL and must be ordered NULLS LAST.';

CREATE INDEX idx_card_index_rarity_rank
  ON public.card_index (rarity_rank);

-- Existing intent was "signed-in users may read catalog". Express that as a
-- target role, not a per-row auth.role() predicate that blocks trigram plans.
ALTER POLICY "card_index read" ON public.card_index
  TO authenticated
  USING (true);

ANALYZE public.card_index;
