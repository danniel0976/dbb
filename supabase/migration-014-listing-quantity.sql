-- Listing quantities: one condition photo per library_card row, any number of
-- owned copies may be offered in a singles listing or claim sale.
-- Apply in Supabase SQL Editor after migration-013.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_quantity_positive;

ALTER TABLE public.listings
  ADD CONSTRAINT listings_quantity_positive CHECK (quantity > 0);

COMMENT ON COLUMN public.listings.quantity IS
  'Number of copies offered from library_cards.quantity. One card_photos row for the library_card covers all offered copies.';
