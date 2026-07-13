-- migration-014: Listing quantities
-- One condition photo per library_card row covers all offered copies.
-- A seller may offer 1 through their owned copy count in a singles listing or claim sale.
-- Apply in Supabase SQL Editor after migration-013.

-- Add quantity column with safe default so existing rows remain valid (1 copy).
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;

-- Ensure quantity is always a positive integer.
ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_quantity_positive;

ALTER TABLE public.listings
  ADD CONSTRAINT listings_quantity_positive CHECK (quantity > 0);

COMMENT ON COLUMN public.listings.quantity IS
  'Number of copies offered from library_cards.quantity. One card_photos row for the library_card covers all offered copies.';