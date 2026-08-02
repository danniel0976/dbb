-- Phase 45C repair: restore the reserved-listing protection invariant.
--
-- Defect (Phase 45C case 7a, observed at runtime): an authenticated seller could
-- PATCH listings.quantity (HTTP 200) while a non-final order reserved that
-- listing, immediately after a successful checkout (HTTP 201). The exclusive
-- winner/protection invariant was not enforced at all.
--
-- Root cause: public.protect_reserved_listing() is SECURITY DEFINER and is owned
-- by `postgres`. Inside a SECURITY DEFINER function `current_user` is the DEFINER,
-- not the caller, so the guard clause
--     current_user IN ('postgres', 'service_role')
-- evaluated to TRUE for every caller, including PostgREST `authenticated`
-- requests, and the function returned before reaching the active-order check.
-- The second disjunct, current_setting('request.jwt.claim.role', true), is the
-- PostgREST <v9 singular GUC and is NULL under the PostgREST v14 in use, so it
-- provided no coverage either. The protection was effectively dead code.
--
-- Repair: decide the bypass from the request context rather than the definer
-- context. auth.role() reads the per-request JWT claims GUC (coalescing the
-- legacy singular and current `request.jwt.claims` JSON forms) and is unaffected
-- by SECURITY DEFINER. session_user is the real login role and is likewise
-- unaffected by SECURITY DEFINER or SET ROLE, so it distinguishes a direct
-- backend session from a PostgREST request (which logs in as `authenticator`).
--
-- The bypass is fail-closed: it applies only to an explicit service_role request
-- or to a direct trusted backend session (migrations, seeds, psql maintenance).
-- Every other caller -- `authenticated`, `anon`, or any PostgREST request without
-- claims -- is subject to the active-order check.
--
-- The active-order predicate itself is intentionally unchanged.

CREATE OR REPLACE FUNCTION public.protect_reserved_listing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request_role text := auth.role();
BEGIN
  -- Trusted server-side callers. Not current_user: this function is SECURITY
  -- DEFINER, so current_user is always the definer and would bypass everyone.
  IF v_request_role = 'service_role'
     OR (v_request_role IS NULL AND session_user IN ('postgres', 'supabase_admin'))
  THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.listing_id = OLD.id
      AND o.status NOT IN ('order_completed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Listing is reserved by an active order' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

COMMENT ON FUNCTION public.protect_reserved_listing() IS
  'Owns the reserved-listing protection invariant. Bypass is decided from the request context (auth.role()) and the real login role (session_user), never from current_user, because this function is SECURITY DEFINER.';

-- Re-assert the trigger binding so the invariant owner cannot drift.
DROP TRIGGER IF EXISTS listings_protect_active_orders ON public.listings;
CREATE TRIGGER listings_protect_active_orders
  BEFORE UPDATE OR DELETE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.protect_reserved_listing();
