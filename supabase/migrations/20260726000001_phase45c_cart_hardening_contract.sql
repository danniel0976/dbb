-- Phase 45C contract: activate the service-only cart mutation boundary.
-- Apply only after the compatible expand migration and application rollout.
-- The expand migration leaves legacy authenticated cart writes available so an
-- older app can coexist during deployment; this migration closes that boundary.

DROP POLICY IF EXISTS cart_items_insert_own ON public.cart_items;
DROP POLICY IF EXISTS cart_items_update_own ON public.cart_items;
DROP POLICY IF EXISTS cart_items_delete_own ON public.cart_items;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cart_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cart_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cart_items TO service_role;

COMMENT ON TABLE public.cart_items IS
  'Non-reserving buyer intent. Mutations require phase45c_cart_* service functions.';
