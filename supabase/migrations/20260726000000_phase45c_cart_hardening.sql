-- Phase 45C: quantity-aware cart and shared stock-concurrency hardening.
-- Expand/contract migration.  The baseline and prior Phase 45 migrations are
-- intentionally left unchanged.  Cart mutation and checkout RPCs are service
-- role only; authenticated users retain cart SELECT through RLS.

-- Expand-only schema changes. The matching contract is a later migration so
-- old application versions can continue to write cart rows during rollout.
ALTER TABLE public.claim_sales
  ADD COLUMN IF NOT EXISTS featured_listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL;

ALTER TABLE public.cart_items
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;

ALTER TABLE public.cart_items
  DROP CONSTRAINT IF EXISTS cart_items_quantity_range,
  ADD CONSTRAINT cart_items_quantity_range CHECK (quantity BETWEEN 1 AND 9999),
  DROP CONSTRAINT IF EXISTS cart_items_version_positive,
  ADD CONSTRAINT cart_items_version_positive CHECK (version >= 1);

CREATE INDEX IF NOT EXISTS idx_cart_items_user_updated
  ON public.cart_items (user_id, updated_at, id);

ALTER TABLE public.checkout_requests
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

CREATE INDEX IF NOT EXISTS idx_checkout_requests_fingerprint
  ON public.checkout_requests (buyer_id, idempotency_key, request_fingerprint);

-- The cart write policy/privilege cutover is deliberately in
-- 20260726000001_phase45c_cart_hardening_contract.sql.

CREATE OR REPLACE FUNCTION public.phase45c_claim_sale_eligible(p_claim_sale_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_claim_sale_id IS NULL OR EXISTS (
    SELECT 1 FROM public.claim_sales cs
    WHERE cs.id = p_claim_sale_id
      AND cs.status = 'active'
      AND cs.expires_at > now()
  )
$$;

-- Card ownership is derived from the canonical library row.  A listing's
-- seller_id is not trusted as a substitute: it is only valid when it matches
-- the owner of the library card being committed.
CREATE OR REPLACE FUNCTION public.phase45c_listing_card_owned(p_listing_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.listings l
    JOIN public.library_cards lc ON lc.id = l.library_card_id
    WHERE l.id = p_listing_id AND l.user_id = lc.user_id
  )
$$;

-- Shared lock hierarchy for every 45C stock path:
--   buyer advisory lock (cart/checkout only), listing UUID, Claim Sale UUID,
--   library-card UUID, reservation key, cart row, order row.
-- Listing rows are locked before their parent/card/reservation rows. This is
-- deliberate: direct seller listing writes acquire the listing row before an
-- AFTER trigger can synchronize its parent and ledger rows.
CREATE OR REPLACE FUNCTION public.phase45c_lock_buyer(p_buyer_id uuid)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('phase45c:buyer:' || p_buyer_id::text, 0))
$$;

-- Every Claim Sale path uses this one resource acquisition primitive. It locks
-- all child listings first, then the parent, then cards and reservations. A
-- parent status trigger must not acquire child locks: doing so would recreate
-- the expiry/checkout cycle this migration is designed to prevent.
CREATE OR REPLACE FUNCTION public.phase45c_lock_claim_sale_resources(p_claim_sale_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
  v_reservation public.marketplace_card_reservations%ROWTYPE;
  v_claim public.claim_sales%ROWTYPE;
BEGIN
  FOR v_listing IN
    SELECT * FROM public.listings
    WHERE claim_sale_id = p_claim_sale_id ORDER BY id FOR UPDATE
  LOOP NULL; END LOOP;
  SELECT * INTO v_claim FROM public.claim_sales WHERE id = p_claim_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_SALE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  FOR v_card IN
    SELECT * FROM public.library_cards
    WHERE id IN (SELECT library_card_id FROM public.listings WHERE claim_sale_id = p_claim_sale_id)
    ORDER BY id FOR UPDATE
  LOOP NULL; END LOOP;
  FOR v_reservation IN
    SELECT * FROM public.marketplace_card_reservations
    WHERE source_kind = 'listing' AND source_id IN
      (SELECT id FROM public.listings WHERE claim_sale_id = p_claim_sale_id)
    ORDER BY library_card_id, source_id FOR UPDATE
  LOOP NULL; END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.phase45c_expire_claim_sale(p_claim_sale_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claim public.claim_sales%ROWTYPE;
  v_listing public.listings%ROWTYPE;
BEGIN
  PERFORM public.phase45c_lock_claim_sale_resources(p_claim_sale_id);
  SELECT * INTO v_claim FROM public.claim_sales WHERE id = p_claim_sale_id FOR UPDATE;
  IF v_claim.status <> 'active' OR v_claim.expires_at > now() THEN RETURN false; END IF;
  UPDATE public.claim_sales SET status = 'expired' WHERE id = p_claim_sale_id;
  FOR v_listing IN
    SELECT * FROM public.listings WHERE claim_sale_id = p_claim_sale_id ORDER BY id
  LOOP
    DELETE FROM public.marketplace_card_reservations
    WHERE source_kind = 'listing' AND source_id = v_listing.id;
    UPDATE public.listings SET status = 'expired'
    WHERE id = v_listing.id AND status <> 'expired';
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.phase45c_end_claim_sale(p_claim_sale_id uuid, p_cancel boolean DEFAULT false)
RETURNS public.claim_sales
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claim public.claim_sales%ROWTYPE;
  v_listing public.listings%ROWTYPE;
BEGIN
  PERFORM public.phase45c_lock_claim_sale_resources(p_claim_sale_id);
  SELECT * INTO v_claim FROM public.claim_sales WHERE id = p_claim_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_SALE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF p_cancel THEN
    IF v_claim.status <> 'active' THEN RAISE EXCEPTION 'CLAIM_SALE_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.claim_sales SET status = 'cancelled' WHERE id = p_claim_sale_id RETURNING * INTO v_claim;
  ELSIF v_claim.status = 'active' AND v_claim.expires_at <= now() THEN
    UPDATE public.claim_sales SET status = 'expired' WHERE id = p_claim_sale_id RETURNING * INTO v_claim;
  END IF;
  -- Never unlink a cancelled/expired card: doing so would silently turn it
  -- back into a Bazaar Single. Expiring the child rows makes the reservation
  -- trigger remove their listing commitments in this same transaction.
  IF v_claim.status IN ('cancelled', 'expired') THEN
    FOR v_listing IN SELECT * FROM public.listings WHERE claim_sale_id = p_claim_sale_id ORDER BY id LOOP
      UPDATE public.listings SET status = 'expired' WHERE id = v_listing.id AND status <> 'expired';
      DELETE FROM public.marketplace_card_reservations
      WHERE source_kind = 'listing' AND source_id = v_listing.id;
    END LOOP;
  END IF;
  RETURN v_claim;
END $$;

CREATE OR REPLACE FUNCTION public.phase45c_cancel_claim_sale(p_claim_sale_id uuid, p_actor_id uuid)
RETURNS public.claim_sales
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claim public.claim_sales%ROWTYPE;
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
  v_reservation public.marketplace_card_reservations%ROWTYPE;
BEGIN
  PERFORM public.phase45c_lock_claim_sale_resources(p_claim_sale_id);
  SELECT * INTO v_claim FROM public.claim_sales WHERE id = p_claim_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_SALE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_claim.user_id <> p_actor_id THEN RAISE EXCEPTION 'CLAIM_SALE_NOT_OWNER' USING ERRCODE = 'P0001'; END IF;
  IF v_claim.status <> 'active' THEN RAISE EXCEPTION 'CLAIM_SALE_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.listings l
    JOIN public.library_cards lc ON lc.id = l.library_card_id
    WHERE l.claim_sale_id = p_claim_sale_id AND l.user_id <> lc.user_id
  ) THEN
    RAISE EXCEPTION 'LISTING_CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  FOR v_listing IN SELECT * FROM public.listings WHERE claim_sale_id = p_claim_sale_id ORDER BY id LOOP
    DELETE FROM public.marketplace_card_reservations WHERE source_kind = 'listing' AND source_id = v_listing.id;
    UPDATE public.listings SET status = 'expired' WHERE id = v_listing.id AND status <> 'expired';
  END LOOP;
  UPDATE public.claim_sales SET status = 'cancelled' WHERE id = p_claim_sale_id RETURNING * INTO v_claim;
  RETURN v_claim;
END $$;

CREATE OR REPLACE FUNCTION public.phase45c_reconcile_expired_listings(p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claim public.claim_sales%ROWTYPE;
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
  v_count integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'INVALID_LIMIT' USING ERRCODE = '22023';
  END IF;
  -- Temporal expiry uses the same listing -> parent -> card/reservation helper
  -- as checkout and cancellation. The trigger below is intentionally passive.
  FOR v_claim IN
    SELECT * FROM public.claim_sales
    WHERE status = 'active' AND expires_at <= now()
    ORDER BY id LIMIT p_limit
  LOOP
    IF public.phase45c_expire_claim_sale(v_claim.id) THEN v_count := v_count + 1; END IF;
  END LOOP;
  FOR v_listing IN
    SELECT * FROM public.listings
    WHERE status = 'active' AND claim_sale_id IS NULL AND expires_at <= now()
    ORDER BY id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    IF NOT public.phase45c_listing_card_owned(v_listing.id) THEN
      RAISE EXCEPTION 'LISTING_CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
    DELETE FROM public.marketplace_card_reservations
    WHERE source_kind = 'listing' AND source_id = v_listing.id;
    UPDATE public.listings SET status = 'expired' WHERE id = v_listing.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.phase45c_cart_add(
  p_buyer_id uuid, p_listing_id uuid, p_quantity integer DEFAULT 1
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
  v_item public.cart_items%ROWTYPE;
BEGIN
  IF p_buyer_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.phase45c_lock_buyer(p_buyer_id);
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 9999 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = '22023';
  END IF;
  SELECT claim_sale_id INTO v_listing.claim_sale_id FROM public.listings WHERE id = p_listing_id;
  IF v_listing.claim_sale_id IS NOT NULL THEN
    PERFORM public.phase45c_expire_claim_sale(v_listing.claim_sale_id);
  END IF;
  SELECT * INTO v_listing FROM public.listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id FOR UPDATE;
  IF NOT FOUND OR v_card.user_id <> v_listing.user_id THEN
    RAISE EXCEPTION 'LISTING_CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_listing.user_id = p_buyer_id THEN RAISE EXCEPTION 'OWN_LISTING' USING ERRCODE = 'P0001'; END IF;
  IF v_listing.status <> 'active' OR v_listing.expires_at <= now() THEN
    RAISE EXCEPTION 'LISTING_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.phase45c_claim_sale_eligible(v_listing.claim_sale_id) THEN
    RAISE EXCEPTION 'CLAIM_SALE_ENDED' USING ERRCODE = 'P0001';
  END IF;
  IF v_listing.quantity < p_quantity THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK' USING ERRCODE = 'P0001',
      DETAIL = jsonb_build_object('requested', p_quantity, 'available', v_listing.quantity)::text;
  END IF;

  PERFORM 1 FROM public.marketplace_card_reservations
    WHERE library_card_id = v_listing.library_card_id AND source_kind = 'listing' AND source_id = v_listing.id FOR UPDATE;
  SELECT * INTO v_item FROM public.cart_items
  WHERE user_id = p_buyer_id AND listing_id = p_listing_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('item', to_jsonb(v_item), 'already_in_cart', true,
      'available_quantity', v_listing.quantity);
  END IF;
  INSERT INTO public.cart_items(user_id, listing_id, quantity)
  VALUES (p_buyer_id, p_listing_id, p_quantity)
  RETURNING * INTO v_item;
  RETURN jsonb_build_object('item', to_jsonb(v_item), 'already_in_cart', false,
    'available_quantity', v_listing.quantity);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_item FROM public.cart_items
  WHERE user_id = p_buyer_id AND listing_id = p_listing_id;
  IF FOUND THEN
    RETURN jsonb_build_object('item', to_jsonb(v_item), 'already_in_cart', true);
  END IF;
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION public.phase45c_cart_update(
  p_buyer_id uuid, p_cart_item_id uuid, p_quantity integer, p_expected_version bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item public.cart_items%ROWTYPE;
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
BEGIN
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 9999 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'CART_ITEM_CHANGED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.phase45c_lock_buyer(p_buyer_id);
  SELECT * INTO v_item FROM public.cart_items
  WHERE id = p_cart_item_id AND user_id = p_buyer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CART_ITEM_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_item.version <> p_expected_version AND v_item.quantity = p_quantity THEN
    RETURN jsonb_build_object('item', to_jsonb(v_item), 'idempotent_replay', true);
  END IF;
  IF v_item.version <> p_expected_version AND v_item.quantity <> p_quantity THEN
    RAISE EXCEPTION 'CART_ITEM_CHANGED' USING ERRCODE = 'P0001',
      DETAIL = jsonb_build_object('id', v_item.id, 'quantity', v_item.quantity,
        'version', v_item.version)::text;
  END IF;
  SELECT claim_sale_id INTO v_listing.claim_sale_id FROM public.listings WHERE id = v_item.listing_id;
  IF v_listing.claim_sale_id IS NOT NULL THEN
    PERFORM public.phase45c_expire_claim_sale(v_listing.claim_sale_id);
  END IF;
  SELECT * INTO v_listing FROM public.listings WHERE id = v_item.listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id FOR UPDATE;
  IF NOT FOUND OR v_card.user_id <> v_listing.user_id THEN
    RAISE EXCEPTION 'LISTING_CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_listing.status <> 'active' OR v_listing.expires_at <= now() THEN
    RAISE EXCEPTION 'LISTING_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.phase45c_claim_sale_eligible(v_listing.claim_sale_id) THEN
    RAISE EXCEPTION 'CLAIM_SALE_ENDED' USING ERRCODE = 'P0001';
  END IF;
  IF p_quantity > v_listing.quantity THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK' USING ERRCODE = 'P0001',
      DETAIL = jsonb_build_object('requested', p_quantity, 'available', v_listing.quantity)::text;
  END IF;
  PERFORM 1 FROM public.marketplace_card_reservations
    WHERE library_card_id = v_listing.library_card_id AND source_kind = 'listing' AND source_id = v_listing.id FOR UPDATE;
  SELECT * INTO v_item FROM public.cart_items WHERE id = p_cart_item_id AND user_id = p_buyer_id FOR UPDATE;
  IF p_quantity <> v_item.quantity THEN
    UPDATE public.cart_items SET quantity = p_quantity, version = version + 1,
      updated_at = now() WHERE id = v_item.id RETURNING * INTO v_item;
  END IF;
  RETURN jsonb_build_object('item', to_jsonb(v_item), 'available_quantity', v_listing.quantity);
END $$;

CREATE OR REPLACE FUNCTION public.phase45c_cart_delete(
  p_buyer_id uuid, p_cart_item_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.phase45c_lock_buyer(p_buyer_id);
  DELETE FROM public.cart_items WHERE id = p_cart_item_id AND user_id = p_buyer_id;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.phase45c_claim_sale_eligible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_listing_card_owned(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_lock_buyer(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_lock_claim_sale_resources(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_expire_claim_sale(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_end_claim_sale(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_cancel_claim_sale(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_reconcile_expired_listings(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_cart_add(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_cart_update(uuid, uuid, integer, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_cart_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase45c_cart_add(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.phase45c_cart_update(uuid, uuid, integer, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.phase45c_cart_delete(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.phase45c_cancel_claim_sale(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.phase45c_reconcile_expired_listings(integer) TO service_role;

-- Quantity-aware checkout.  The API computes request_fingerprint from the
-- authenticated buyer, pickup location, and sorted (cart_item_id, quantity)
-- set.  Prices are server snapshots; card/listing/seller fields are always
-- loaded from locked database rows below.
CREATE OR REPLACE FUNCTION public.checkout_orders(
  p_buyer_id uuid, p_idempotency_key uuid, p_pickup_location_id uuid,
  p_items jsonb, p_request_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item jsonb;
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
  v_cart public.cart_items%ROWTYPE;
  v_req public.checkout_requests%ROWTYPE;
  v_order_id uuid;
  v_order_ids uuid[] := '{}';
  v_seller_id uuid;
  v_q integer;
  v_unit numeric(12,2);
  v_line numeric(12,2);
  v_total numeric(12,2);
  v_listing_reservation public.marketplace_card_reservations%ROWTYPE;
  v_card_reserved integer;
  v_order_reserved integer;
  v_count integer;
  v_cart_count integer;
  v_claim_id uuid;
BEGIN
  IF p_buyer_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.phase45c_lock_buyer(p_buyer_id);
  IF p_request_fingerprint IS NULL OR btrim(p_request_fingerprint) = '' THEN
    RAISE EXCEPTION 'CART_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'CART_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'CART_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT value->>'cart_item_id') FROM jsonb_array_elements(p_items))
     OR (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT value->>'listing_id') FROM jsonb_array_elements(p_items)) THEN
    RAISE EXCEPTION 'CART_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(p_items)
      WHERE jsonb_typeof(value) <> 'object'
        OR jsonb_typeof(value->'cart_item_id') <> 'string'
        OR jsonb_typeof(value->'listing_id') <> 'string'
        OR jsonb_typeof(value->'quantity') <> 'number'
        OR jsonb_typeof(value->'unit_myr') <> 'number'
        OR jsonb_typeof(value->'multiplier') <> 'number'
        OR value->>'cart_item_id' IS NULL OR value->>'listing_id' IS NULL
        OR value->>'quantity' IS NULL
        OR (value->>'cart_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR (value->>'listing_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR (value->>'quantity') !~ '^(0|[1-9][0-9]{0,3})$'
        OR (value->>'unit_myr') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$'
        OR (value->>'multiplier') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$') <> 0 THEN
    RAISE EXCEPTION 'CART_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.checkout_requests(buyer_id, idempotency_key, request_fingerprint)
  VALUES (p_buyer_id, p_idempotency_key, p_request_fingerprint)
  ON CONFLICT (buyer_id, idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO v_req FROM public.checkout_requests
    WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key FOR UPDATE;
    IF v_req.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = 'P0001';
    END IF;
    IF v_req.status = 'completed' THEN
      RETURN jsonb_build_object('order_ids', to_jsonb(v_req.order_ids), 'idempotent_replay', true);
    END IF;
    RAISE EXCEPTION 'CHECKOUT_IN_PROGRESS' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.pickup_locations WHERE id = p_pickup_location_id AND active) THEN
    RAISE EXCEPTION 'PICKUP_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- Lock every Claim Sale's complete child-listing set before its parent,
  -- card, and reservation rows. This prevents a checkout that contains one
  -- child from racing an expiry sweep that needs another child.
  FOR v_claim_id IN
    SELECT DISTINCT l.claim_sale_id FROM public.listings l
    JOIN jsonb_array_elements(p_items) e ON (e.value->>'listing_id')::uuid = l.id
    WHERE l.claim_sale_id IS NOT NULL ORDER BY l.claim_sale_id
  LOOP
    PERFORM public.phase45c_expire_claim_sale(v_claim_id);
  END LOOP;
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(p_items) e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.listings l
      WHERE l.id = (e.value->>'listing_id')::uuid AND l.claim_sale_id IS NOT NULL
    )
    ORDER BY value->>'listing_id'
  LOOP
    SELECT * INTO v_listing FROM public.listings
    WHERE id = (v_item->>'listing_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  END LOOP;
  FOR v_card IN
    SELECT lc.* FROM public.library_cards lc
    JOIN public.listings l ON l.library_card_id = lc.id
    JOIN jsonb_array_elements(p_items) e ON (e.value->>'listing_id')::uuid = l.id
    ORDER BY lc.id FOR UPDATE
  LOOP NULL; END LOOP;
  FOR v_listing_reservation IN
    SELECT mcr.* FROM public.marketplace_card_reservations mcr
    JOIN public.listings l ON l.library_card_id = mcr.library_card_id
    JOIN jsonb_array_elements(p_items) e ON (e.value->>'listing_id')::uuid = l.id
    WHERE mcr.source_kind = 'listing'
    ORDER BY l.id, mcr.library_card_id FOR UPDATE
  LOOP NULL; END LOOP;

  SELECT count(*) INTO v_cart_count FROM public.cart_items WHERE user_id = p_buyer_id;
  IF v_cart_count <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'CART_STALE' USING ERRCODE = 'P0001';
  END IF;
  FOR v_cart IN SELECT * FROM public.cart_items WHERE user_id = p_buyer_id ORDER BY id FOR UPDATE LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) e
      WHERE (e.value->>'cart_item_id')::uuid = v_cart.id
        AND (e.value->>'quantity')::integer = v_cart.quantity
        AND (e.value->>'listing_id')::uuid = v_cart.listing_id) THEN
      RAISE EXCEPTION 'CART_STALE' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- Revalidate every submitted line after locks.  Client listing/card/seller
  -- fields are deliberately ignored; only server snapshots are inserted.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'listing_id' LOOP
    v_q := (v_item->>'quantity')::integer;
    IF v_q < 1 OR v_q > 9999 THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = '22023'; END IF;
    SELECT * INTO v_listing FROM public.listings WHERE id = (v_item->>'listing_id')::uuid;
    IF v_listing.user_id = p_buyer_id THEN RAISE EXCEPTION 'OWN_LISTING' USING ERRCODE = 'P0001'; END IF;
    IF v_listing.status <> 'active' OR v_listing.expires_at <= now() THEN
      RAISE EXCEPTION 'LISTING_UNAVAILABLE' USING ERRCODE = 'P0001';
    END IF;
    IF NOT public.phase45c_claim_sale_eligible(v_listing.claim_sale_id) THEN
      RAISE EXCEPTION 'CLAIM_SALE_ENDED' USING ERRCODE = 'P0001';
    END IF;
    IF v_q > v_listing.quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK' USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object('listing_id', v_listing.id,
          'requested', v_q, 'available', v_listing.quantity)::text;
    END IF;
    SELECT * INTO v_cart FROM public.cart_items
    WHERE id = (v_item->>'cart_item_id')::uuid FOR UPDATE;
    IF NOT FOUND OR v_cart.user_id <> p_buyer_id OR v_cart.listing_id <> v_listing.id
      OR v_cart.quantity <> v_q THEN
      RAISE EXCEPTION 'CART_STALE' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id;
    IF NOT FOUND OR v_card.user_id <> v_listing.user_id THEN
      RAISE EXCEPTION 'LISTING_CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
    IF v_card.quantity < 1 THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK' USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = v_listing.user_id
        AND p.merchant_profile_completed_at IS NOT NULL
        AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
        AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
        AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL
          OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)
    ) THEN RAISE EXCEPTION 'SELLER_INELIGIBLE' USING ERRCODE = 'P0001'; END IF;
    IF (v_item->>'unit_myr') IS NULL OR jsonb_typeof(v_item->'unit_myr') <> 'number'
      OR (v_item->>'unit_myr') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$'
      OR (v_item->>'multiplier') IS NULL OR jsonb_typeof(v_item->'multiplier') <> 'number'
      OR (v_item->>'multiplier') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$'
      OR (v_item->>'multiplier')::numeric IS DISTINCT FROM v_listing.multiplier THEN
      RAISE EXCEPTION 'PRICE_UNAVAILABLE' USING ERRCODE = 'P0001';
    END IF;
    v_unit := (v_item->>'unit_myr')::numeric;
    IF v_unit <= 0 OR round(v_unit, 2) <> v_unit THEN RAISE EXCEPTION 'PRICE_UNAVAILABLE' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_listing_reservation FROM public.marketplace_card_reservations
    WHERE library_card_id = v_listing.library_card_id
      AND source_kind = 'listing' AND source_id = v_listing.id FOR UPDATE;
    IF NOT FOUND OR v_listing_reservation.reserved_quantity <> v_listing.quantity
      OR v_listing_reservation.reserved_quantity < v_q THEN
      RAISE EXCEPTION 'RESERVATION_DRIFT' USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(sum(reserved_quantity), 0) INTO v_card_reserved
    FROM public.marketplace_card_reservations WHERE library_card_id = v_card.id;
    IF v_card_reserved > v_card.quantity THEN RAISE EXCEPTION 'RESERVATION_DRIFT' USING ERRCODE = 'P0001'; END IF;
  END LOOP;

  -- Create seller-grouped orders and transfer exactly q units from listing to
  -- order reservations.  Every write remains inside this transaction.
  FOR v_seller_id IN
    SELECT DISTINCT l.user_id FROM jsonb_array_elements(p_items) e
    JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid ORDER BY l.user_id
  LOOP
    SELECT round(sum((e.value->>'unit_myr')::numeric * (e.value->>'quantity')::integer), 2)
      INTO v_total
    FROM jsonb_array_elements(p_items) e
    JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid
    WHERE l.user_id = v_seller_id;
    INSERT INTO public.orders(buyer_id, seller_id, pickup_location_id, total_myr)
    VALUES (p_buyer_id, v_seller_id, p_pickup_location_id, v_total) RETURNING id INTO v_order_id;
    v_order_ids := array_append(v_order_ids, v_order_id);
    FOR v_item IN
      SELECT e.value FROM jsonb_array_elements(p_items) e
      JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid
      WHERE l.user_id = v_seller_id ORDER BY l.id
    LOOP
      v_q := (v_item->>'quantity')::integer;
      SELECT * INTO v_listing FROM public.listings WHERE id = (v_item->>'listing_id')::uuid;
    SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id;
      v_unit := (v_item->>'unit_myr')::numeric;
      v_line := round(v_unit * v_q, 2);
      DELETE FROM public.marketplace_card_reservations
      WHERE source_kind = 'listing' AND source_id = v_listing.id;
      UPDATE public.listings SET quantity = quantity - v_q,
        status = CASE WHEN quantity - v_q = 0 THEN 'reserved' ELSE 'active' END
      WHERE id = v_listing.id;
      INSERT INTO public.marketplace_card_reservations
        (library_card_id, owner_id, source_kind, source_id, reserved_quantity)
      VALUES (v_listing.library_card_id, v_listing.user_id, 'order', v_order_id, v_q);
      INSERT INTO public.order_items(
        order_id, listing_id, library_card_id, quantity, unit_myr, line_myr,
        multiplier, price_source, scryfall_id, card_name, set_code, set_name,
        collector_number, foil, condition
      ) VALUES (
        v_order_id, v_listing.id, v_listing.library_card_id, v_q, v_unit, v_line,
        v_listing.multiplier, 'single_multiplier', v_card.scryfall_id,
        coalesce((SELECT ci.name FROM public.card_index ci WHERE ci.scryfall_id = v_card.scryfall_id), 'Unknown card'),
        (SELECT ci.set_code FROM public.card_index ci WHERE ci.scryfall_id = v_card.scryfall_id),
        (SELECT ci.set_name FROM public.card_index ci WHERE ci.scryfall_id = v_card.scryfall_id),
        (SELECT ci.collector_number FROM public.card_index ci WHERE ci.scryfall_id = v_card.scryfall_id),
        v_card.foil, v_card.condition
      );
    END LOOP;
    INSERT INTO public.order_events(order_id, actor_id, event_type, to_status)
    VALUES (v_order_id, p_buyer_id, 'checkout_created', 'awaiting_payment');
  END LOOP;

  DELETE FROM public.cart_items WHERE user_id = p_buyer_id
    AND id IN (SELECT (value->>'cart_item_id')::uuid FROM jsonb_array_elements(p_items));
  UPDATE public.checkout_requests SET status = 'completed', order_ids = v_order_ids,
    completed_at = now(), request_fingerprint = p_request_fingerprint
  WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key;
  RETURN jsonb_build_object('order_ids', to_jsonb(v_order_ids), 'idempotent_replay', false);
END $$;

-- Compatibility for the old service-only one-unit entry point.  It delegates
-- to exactly the same reservation-maintaining core.
CREATE OR REPLACE FUNCTION public.checkout_orders(
  p_buyer_id uuid, p_idempotency_key uuid, p_pickup_location_id uuid, p_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_items jsonb := '[]'::jsonb; v_item jsonb; v_fp text;
  v_listing public.listings%ROWTYPE;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'CART_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) <> 'object'
      OR jsonb_typeof(v_item->'listing_id') <> 'string'
      OR jsonb_typeof(v_item->'cart_item_id') <> 'string'
      OR jsonb_typeof(v_item->'unit_myr') <> 'number'
      OR (v_item->>'listing_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (v_item->>'cart_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (v_item->>'unit_myr') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'CART_SNAPSHOT_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_listing FROM public.listings WHERE id = (v_item->>'listing_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
    v_items := v_items || jsonb_build_array(v_item || jsonb_build_object('quantity', 1, 'multiplier', v_listing.multiplier));
  END LOOP;
  v_fp := md5(jsonb_build_array(p_buyer_id::text, p_pickup_location_id::text, v_items)::text);
  RETURN public.checkout_orders(p_buyer_id, p_idempotency_key, p_pickup_location_id, v_items, v_fp);
END $$;

REVOKE ALL ON FUNCTION public.checkout_orders(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkout_orders(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_orders(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkout_orders(uuid, uuid, uuid, jsonb, text) TO service_role;

-- Maintain the shared order reservation ledger for terminal transitions.  The
-- function keeps the existing Phase 39 state machine and auction branches,
-- while adding deterministic card/listing locks and exact quantity restore.
CREATE OR REPLACE FUNCTION public.transition_order(
  p_order_id uuid, p_actor_id uuid, p_action text, p_reason text DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_from text;
  v_item public.order_items%ROWTYPE;
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
  v_reservation public.marketplace_card_reservations%ROWTYPE;
BEGIN
  -- Terminal paths discover their immutable line resources first, then lock
  -- the order row. This keeps checkout/listing/order races on one hierarchy.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF p_action IN ('order_completed', 'cancel') THEN
    FOR v_listing IN
      SELECT l.* FROM public.listings l JOIN public.order_items oi ON oi.listing_id = l.id
      WHERE oi.order_id = p_order_id ORDER BY l.id FOR UPDATE
    LOOP NULL; END LOOP;
    FOR v_card IN
      SELECT lc.* FROM public.library_cards lc JOIN public.order_items oi ON oi.library_card_id = lc.id
      WHERE oi.order_id = p_order_id ORDER BY lc.id FOR UPDATE
    LOOP NULL; END LOOP;
    FOR v_reservation IN
      SELECT m.* FROM public.marketplace_card_reservations m
      JOIN public.order_items oi ON oi.library_card_id = m.library_card_id
      WHERE oi.order_id = p_order_id ORDER BY m.library_card_id, m.source_id FOR UPDATE
    LOOP NULL; END LOOP;
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  v_from := v_order.status;
  -- Authorization must precede terminal replay. Otherwise any signed-in user
  -- who knows an order UUID could replay it through the service RPC.
  IF p_action = 'order_completed' AND p_actor_id <> v_order.buyer_id THEN
    RAISE EXCEPTION 'ORDER_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  IF p_action = 'cancel' AND p_actor_id <> v_order.seller_id THEN
    RAISE EXCEPTION 'ORDER_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  IF p_action IN ('order_completed', 'cancel') THEN
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id = p_order_id ORDER BY listing_id NULLS LAST LOOP
      IF v_item.listing_id IS NOT NULL AND v_item.library_card_id IS NOT NULL THEN
        SELECT * INTO v_listing FROM public.listings WHERE id = v_item.listing_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
        SELECT * INTO v_card FROM public.library_cards WHERE id = v_item.library_card_id;
        IF NOT FOUND OR v_listing.library_card_id <> v_item.library_card_id
          OR v_card.user_id <> v_listing.user_id THEN
          RAISE EXCEPTION 'LISTING_CARD_OWNER_MISMATCH' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF p_action = 'order_completed' AND v_from = 'order_completed' THEN RETURN v_order; END IF;
  IF p_action = 'cancel' AND v_from = 'cancelled' THEN RETURN v_order; END IF;

  IF p_action = 'preparing_order' AND p_actor_id = v_order.seller_id AND v_from = 'awaiting_payment' THEN
    UPDATE public.orders SET status='preparing_order', preparing_order_at=now(), updated_at=now()
      WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'payment_received' AND p_actor_id = v_order.seller_id AND v_from = 'preparing_order' THEN
    UPDATE public.orders SET status='payment_received', payment_received_at=now(), updated_at=now()
      WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'dropped_off' AND p_actor_id = v_order.seller_id AND v_from = 'payment_received' THEN
    UPDATE public.orders SET status='dropped_off', dropped_off_at=now(), updated_at=now()
      WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'order_completed' AND p_actor_id = v_order.buyer_id AND v_from = 'dropped_off' THEN
    UPDATE public.orders SET status='order_completed', completed_at=now(), updated_at=now()
      WHERE id=p_order_id RETURNING * INTO v_order;
    DELETE FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=p_order_id;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id=p_order_id ORDER BY library_card_id LOOP
      IF v_item.library_card_id IS NOT NULL THEN
        UPDATE public.library_cards SET quantity=quantity-v_item.quantity
          WHERE id=v_item.library_card_id AND quantity > v_item.quantity;
        IF NOT FOUND THEN DELETE FROM public.library_cards WHERE id=v_item.library_card_id AND quantity=v_item.quantity; END IF;
      END IF;
    END LOOP;
  ELSIF p_action = 'cancel' AND p_actor_id = v_order.seller_id AND v_from NOT IN ('order_completed','cancelled') THEN
    IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 500 THEN
      RAISE EXCEPTION 'INVALID_CANCELLATION_REASON' USING ERRCODE='22023';
    END IF;
    UPDATE public.orders SET status='cancelled', cancelled_at=now(), cancelled_by=p_actor_id,
      cancellation_reason=btrim(p_reason), updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
    DELETE FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=p_order_id;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id=p_order_id ORDER BY listing_id LOOP
      IF v_item.price_source IN ('auction_bid','auction_buyout') THEN
        IF v_item.auction_id IS NOT NULL THEN UPDATE public.auctions SET status='relist_available'
          WHERE id=v_item.auction_id AND status='ended_sold'; END IF;
        CONTINUE;
      END IF;
      IF v_item.listing_id IS NULL THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE='P0001'; END IF;
      SELECT * INTO v_listing FROM public.listings WHERE id=v_item.listing_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE='P0001'; END IF;
      UPDATE public.listings SET quantity=quantity+v_item.quantity,
        status=CASE WHEN expires_at > now() AND public.phase45c_claim_sale_eligible(claim_sale_id)
          AND status <> 'expired' THEN 'active' ELSE 'expired' END
        WHERE id=v_listing.id;
    END LOOP;
    UPDATE public.order_cancellation_requests SET resolved_at=now(), resolved_by=p_actor_id, resolution='accepted'
      WHERE order_id=p_order_id AND resolved_at IS NULL;
  ELSE
    RAISE EXCEPTION 'ORDER_TRANSITION_NOT_ALLOWED' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.order_events(order_id, actor_id, event_type, from_status, to_status, reason)
  VALUES (p_order_id, p_actor_id, p_action, v_from, v_order.status, nullif(btrim(p_reason),''));
  RETURN v_order;
END $$;

REVOKE ALL ON FUNCTION public.transition_order(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_order(uuid, uuid, text, text) TO service_role;

COMMENT ON TABLE public.cart_items IS 'Non-reserving buyer intent. Mutations require phase45c_cart_* service functions.';
COMMENT ON COLUMN public.checkout_requests.request_fingerprint IS 'Canonical buyer/pickup/cart quantity binding for idempotent checkout replay.';

-- Listings can be created/edited by existing service routes after the Phase 45
-- bootstrap has run.  Keep the listing reservation synchronized for every
-- lifecycle write in the same transaction, including direct seller routes.
CREATE OR REPLACE FUNCTION public.phase45c_sync_listing_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_card_quantity integer;
  v_other_reserved integer;
  v_should_reserve boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.marketplace_card_reservations
    WHERE source_kind='listing' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  IF NOT public.phase45c_listing_card_owned(NEW.id) THEN
    RAISE EXCEPTION 'LISTING_CARD_OWNER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  -- The reservation primary key includes library_card_id. Retargeting a
  -- listing needs an explicit old-key delete before the new-card upsert.
  IF TG_OP = 'UPDATE' AND OLD.library_card_id IS DISTINCT FROM NEW.library_card_id THEN
    DELETE FROM public.marketplace_card_reservations
    WHERE source_kind='listing' AND source_id=OLD.id;
  END IF;
  v_should_reserve := NEW.status = 'active' AND NEW.quantity > 0
    AND NEW.expires_at > now() AND public.phase45c_claim_sale_eligible(NEW.claim_sale_id);
  IF NOT v_should_reserve THEN
    DELETE FROM public.marketplace_card_reservations
    WHERE source_kind='listing' AND source_id=NEW.id;
    RETURN NEW;
  END IF;
  SELECT quantity INTO v_card_quantity FROM public.library_cards
  WHERE id=NEW.library_card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  SELECT coalesce(sum(reserved_quantity),0) INTO v_other_reserved
  FROM public.marketplace_card_reservations
  WHERE library_card_id=NEW.library_card_id
    AND NOT (source_kind='listing' AND source_id=NEW.id);
  IF v_other_reserved + NEW.quantity > v_card_quantity THEN
    RAISE EXCEPTION 'RESERVATION_DRIFT' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.marketplace_card_reservations
    (library_card_id, owner_id, source_kind, source_id, reserved_quantity)
  VALUES (NEW.library_card_id, NEW.user_id, 'listing', NEW.id, NEW.quantity)
  ON CONFLICT (library_card_id, source_id) DO UPDATE
    SET owner_id=EXCLUDED.owner_id, reserved_quantity=EXCLUDED.reserved_quantity;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS phase45c_listing_reservation_sync ON public.listings;
CREATE TRIGGER phase45c_listing_reservation_sync
  AFTER INSERT OR UPDATE OF library_card_id, user_id, status, quantity, expires_at, claim_sale_id
  OR DELETE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.phase45c_sync_listing_reservation();

CREATE OR REPLACE FUNCTION public.phase45c_claim_sale_status_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Deliberately passive: lifecycle callers acquire child listings before the
  -- parent. A trigger that acquires children after the parent creates an
  -- inverse lock edge with checkout and the expiry sweep.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS phase45c_claim_sale_status_sync ON public.claim_sales;
CREATE TRIGGER phase45c_claim_sale_status_sync
  AFTER UPDATE OF status ON public.claim_sales
  FOR EACH ROW EXECUTE FUNCTION public.phase45c_claim_sale_status_sync();

-- Reconcile bootstrap rows as one conflict-safe migration transaction. Obsolete
-- listing commitments are removed first; each card is then locked before an
-- exact active-listing row is inserted/updated. Any aggregate conflict aborts
-- the migration instead of committing an over-reserved ledger.
DELETE FROM public.marketplace_card_reservations m
WHERE m.source_kind = 'listing'
  AND NOT EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = m.source_id AND l.library_card_id = m.library_card_id
      AND m.reserved_quantity = l.quantity
      AND l.status = 'active' AND l.quantity > 0
      AND l.expires_at > now() AND public.phase45c_claim_sale_eligible(l.claim_sale_id)
  );

DO $$
DECLARE
  v_listing public.listings%ROWTYPE;
  v_card_qty integer;
  v_card_owner uuid;
  v_other integer;
BEGIN
  FOR v_listing IN
    SELECT * FROM public.listings
    WHERE status = 'active' AND quantity > 0 AND expires_at > now()
      AND public.phase45c_claim_sale_eligible(claim_sale_id)
    ORDER BY library_card_id, id
  LOOP
    SELECT quantity, user_id INTO v_card_qty, v_card_owner FROM public.library_cards
    WHERE id = v_listing.library_card_id FOR UPDATE;
    IF v_card_qty IS NULL THEN RAISE EXCEPTION 'RESERVATION_DRIFT'; END IF;
    IF v_card_owner <> v_listing.user_id THEN
      RAISE EXCEPTION 'LISTING_CARD_OWNER_MISMATCH' USING ERRCODE='P0001';
    END IF;
    SELECT coalesce(sum(reserved_quantity), 0) INTO v_other
    FROM public.marketplace_card_reservations
    WHERE library_card_id = v_listing.library_card_id
      AND NOT (source_kind = 'listing' AND source_id = v_listing.id);
    IF v_other + v_listing.quantity > v_card_qty THEN
      RAISE EXCEPTION 'RESERVATION_DRIFT: listing backfill exceeds physical inventory';
    END IF;
    INSERT INTO public.marketplace_card_reservations
      (library_card_id, owner_id, source_kind, source_id, reserved_quantity)
    VALUES (v_listing.library_card_id, v_listing.user_id, 'listing', v_listing.id, v_listing.quantity)
    ON CONFLICT (library_card_id, source_id) DO UPDATE
      SET owner_id = EXCLUDED.owner_id, reserved_quantity = EXCLUDED.reserved_quantity;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.marketplace_card_reservations m
    JOIN public.library_cards c ON c.id = m.library_card_id
    GROUP BY m.library_card_id, c.quantity
    HAVING sum(m.reserved_quantity) > c.quantity
  ) THEN RAISE EXCEPTION 'RESERVATION_DRIFT: aggregate invariant violated'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.listings l
    LEFT JOIN public.marketplace_card_reservations m
      ON m.source_kind = 'listing' AND m.source_id = l.id
        AND m.library_card_id = l.library_card_id
    WHERE l.status = 'active' AND l.quantity > 0 AND l.expires_at > now()
      AND public.phase45c_claim_sale_eligible(l.claim_sale_id)
      AND (m.source_id IS NULL OR m.library_card_id <> l.library_card_id OR m.reserved_quantity <> l.quantity)
  ) THEN RAISE EXCEPTION 'RESERVATION_DRIFT: active listing reservation mismatch'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.phase45c_guard_card_inventory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_reserved integer;
BEGIN
  SELECT coalesce(sum(reserved_quantity),0) INTO v_reserved
  FROM public.marketplace_card_reservations WHERE library_card_id=OLD.id;
  IF TG_OP='DELETE' AND v_reserved > 0 THEN
    RAISE EXCEPTION 'RESERVATION_DRIFT' USING ERRCODE='P0001';
  END IF;
  IF TG_OP='UPDATE' AND NEW.quantity < v_reserved THEN
    RAISE EXCEPTION 'RESERVATION_DRIFT' USING ERRCODE='P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS phase45c_card_inventory_guard ON public.library_cards;
CREATE TRIGGER phase45c_card_inventory_guard
  BEFORE UPDATE OF quantity OR DELETE ON public.library_cards
  FOR EACH ROW EXECUTE FUNCTION public.phase45c_guard_card_inventory();
