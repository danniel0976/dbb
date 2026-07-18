-- Phase 39: manual bank-in checkout, seller-grouped orders, and store pickup.
-- DO NOT apply automatically. Production application requires Dan's approval.

-- Merchant payment details are private profile fields. They are read only through
-- server-authorized routes for the owner or the buyer during the checkout response.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS merchant_bank_name text,
  ADD COLUMN IF NOT EXISTS merchant_account_name text,
  ADD COLUMN IF NOT EXISTS merchant_account_number text,
  ADD COLUMN IF NOT EXISTS merchant_duitnow_id text,
  ADD COLUMN IF NOT EXISTS merchant_payment_instructions text,
  ADD COLUMN IF NOT EXISTS merchant_bank_qr_path text,
  ADD COLUMN IF NOT EXISTS merchant_tng_qr_path text,
  ADD COLUMN IF NOT EXISTS merchant_profile_completed_at timestamptz;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS merchant_bank_qr_owned_path,
  DROP CONSTRAINT IF EXISTS merchant_tng_qr_owned_path,
  ADD CONSTRAINT merchant_bank_qr_owned_path CHECK (
    merchant_bank_qr_path IS NULL OR merchant_bank_qr_path = id::text || '/bank_qr.jpg'
  ),
  ADD CONSTRAINT merchant_tng_qr_owned_path CHECK (
    merchant_tng_qr_path IS NULL OR merchant_tng_qr_path = id::text || '/tng_qr.jpg'
  );

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'merchant-payment-qr',
  'merchant-payment-qr',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

CREATE TABLE IF NOT EXISTS public.pickup_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  address text NOT NULL,
  operating_notes text,
  active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_default_active_pickup_location
  ON public.pickup_locations (is_default)
  WHERE active AND is_default;

INSERT INTO public.pickup_locations (slug, name, address, operating_notes, active, is_default)
VALUES (
  'cards-and-hobbies-kelana-jaya',
  'Cards & Hobbies',
  'A-3-5, Parklanes Commercial Hub, Jalan SS7/26, Kelana Jaya, 47301 Petaling Jaya, Selangor, Malaysia',
  'Confirm store operating hours before drop-off or pickup.',
  true,
  true
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  address = EXCLUDED.address,
  operating_notes = EXCLUDED.operating_notes,
  active = EXCLUDED.active,
  is_default = EXCLUDED.is_default,
  updated_at = now();

-- migration-014's listings_quantity_positive (quantity > 0) blocks checkout_orders
-- below, which reserves the last unit down to zero (status flips to 'reserved')
-- while the listing row must persist for order-item snapshots and cancellation
-- restoration. Relax the floor to zero; a listing is still hidden from the bazaar
-- once quantity reaches zero because "authenticated can view active listings" is
-- scoped to status = 'active', and checkout_orders flips status to 'reserved' in
-- the same statement that brings quantity to zero.
ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_quantity_positive,
  ADD CONSTRAINT listings_quantity_non_negative CHECK (quantity >= 0);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES public.profiles(id),
  seller_id uuid NOT NULL REFERENCES public.profiles(id),
  pickup_location_id uuid NOT NULL REFERENCES public.pickup_locations(id),
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN (
    'awaiting_payment', 'preparing_order', 'payment_received',
    'dropped_off', 'order_completed', 'cancelled'
  )),
  currency text NOT NULL DEFAULT 'MYR' CHECK (currency = 'MYR'),
  total_myr numeric(12,2) NOT NULL CHECK (total_myr > 0),
  preparing_order_at timestamptz,
  payment_received_at timestamptz,
  dropped_off_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> seller_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_buyer_created ON public.orders (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_seller_created ON public.orders (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_updated ON public.orders (status, updated_at);

CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  library_card_id uuid REFERENCES public.library_cards(id) ON DELETE SET NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_myr numeric(12,2) NOT NULL CHECK (unit_myr > 0),
  line_myr numeric(12,2) NOT NULL CHECK (line_myr > 0),
  multiplier numeric NOT NULL,
  scryfall_id uuid NOT NULL,
  card_name text NOT NULL,
  set_code text,
  set_name text,
  collector_number text,
  foil text,
  condition text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_listing ON public.order_items (listing_id) WHERE listing_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.checkout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES public.profiles(id),
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  order_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (buyer_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  event_type text NOT NULL,
  from_status text,
  to_status text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_created ON public.order_events (order_id, created_at);

CREATE TABLE IF NOT EXISTS public.order_cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(id),
  resolution text CHECK (resolution IN ('accepted', 'declined'))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_cancellation_request_per_order
  ON public.order_cancellation_requests (order_id)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS public.order_no_show_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES public.profiles(id),
  reported_user_id uuid NOT NULL REFERENCES public.profiles(id),
  report_type text NOT NULL CHECK (report_type IN ('buyer_unpaid', 'seller_stale_after_payment')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  eligible_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, reporter_id, report_type)
);

ALTER TABLE public.pickup_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_cancellation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_no_show_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated read active pickup locations" ON public.pickup_locations
  FOR SELECT USING (auth.role() = 'authenticated' AND active);
CREATE POLICY "participants read orders" ON public.orders
  FOR SELECT USING (auth.uid() = buyer_id OR auth.uid() = seller_id);
CREATE POLICY "participants read order items" ON public.order_items
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_id AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
  ));
CREATE POLICY "participants read order events" ON public.order_events
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_id AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
  ));
CREATE POLICY "participants read cancellation requests" ON public.order_cancellation_requests
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_id AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
  ));
CREATE POLICY "participants read no-show reports" ON public.order_no_show_reports
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_id AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
  ));

-- Merchant profiling is enforced in the database as well as the API so direct
-- authenticated inserts cannot bypass it.
CREATE OR REPLACE FUNCTION public.enforce_listing_merchant_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = NEW.user_id
      AND p.merchant_profile_completed_at IS NOT NULL
      AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
      AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
      AND (
        nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR
        nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Complete merchant payment profiling before listing' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS listings_require_merchant_profile ON public.listings;
CREATE TRIGGER listings_require_merchant_profile
  BEFORE INSERT OR UPDATE OF status ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_listing_merchant_profile();

-- Prevent sellers from mutating inventory reserved by a non-final order through
-- direct table access. Checkout mutates before the order item exists; cancellation
-- marks the order final before restoring inventory.
CREATE OR REPLACE FUNCTION public.protect_reserved_listing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role') OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
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

DROP TRIGGER IF EXISTS listings_protect_active_orders ON public.listings;
CREATE TRIGGER listings_protect_active_orders
  BEFORE UPDATE OR DELETE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.protect_reserved_listing();

CREATE OR REPLACE FUNCTION public.checkout_orders(
  p_buyer_id uuid,
  p_idempotency_key uuid,
  p_pickup_location_id uuid,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item jsonb;
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
  v_seller_id uuid;
  v_order_id uuid;
  v_order_ids uuid[] := '{}';
  v_total numeric(12,2);
  v_existing_status text;
  v_existing_ids uuid[];
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'Checkout must contain between 1 and 100 items' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pickup_locations WHERE id = p_pickup_location_id AND active) THEN
    RAISE EXCEPTION 'Pickup location is unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT value->>'listing_id') FROM jsonb_array_elements(p_items)) THEN
    RAISE EXCEPTION 'Duplicate listing in checkout' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.checkout_requests (buyer_id, idempotency_key)
  VALUES (p_buyer_id, p_idempotency_key)
  ON CONFLICT (buyer_id, idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT status, order_ids INTO v_existing_status, v_existing_ids
    FROM public.checkout_requests
    WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_existing_status = 'completed' THEN
      RETURN jsonb_build_object('order_ids', to_jsonb(v_existing_ids), 'idempotent_replay', true);
    END IF;
    RAISE EXCEPTION 'Checkout request is already processing' USING ERRCODE = 'P0001';
  END IF;

  -- Lock and validate every item before writing any order row.
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'listing_id'
  LOOP
    SELECT * INTO v_listing FROM public.listings
    WHERE id = (v_item->>'listing_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found: %', v_item->>'listing_id' USING ERRCODE = 'P0001'; END IF;
    IF v_listing.user_id = p_buyer_id THEN RAISE EXCEPTION 'Cannot checkout your own listing' USING ERRCODE = 'P0001'; END IF;
    IF v_listing.status <> 'active' OR v_listing.expires_at <= now() THEN RAISE EXCEPTION 'Listing is unavailable: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
    IF v_listing.quantity < 1 THEN RAISE EXCEPTION 'Insufficient listing quantity: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.cart_items
      WHERE id = (v_item->>'cart_item_id')::uuid
        AND user_id = p_buyer_id AND listing_id = v_listing.id
    ) THEN RAISE EXCEPTION 'Item is not in buyer cart: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
    IF (v_item->>'unit_myr')::numeric <= 0 THEN RAISE EXCEPTION 'Trusted price missing for listing: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = v_listing.user_id AND p.merchant_profile_completed_at IS NOT NULL
        AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
        AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
        AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)
    ) THEN RAISE EXCEPTION 'Seller payment profile is incomplete' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id FOR UPDATE;
    IF NOT FOUND OR v_card.quantity < 1 THEN RAISE EXCEPTION 'Seller inventory is unavailable: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
  END LOOP;

  FOR v_seller_id IN
    SELECT DISTINCT l.user_id
    FROM jsonb_array_elements(p_items) e
    JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid
    ORDER BY l.user_id
  LOOP
    SELECT round(sum((e.value->>'unit_myr')::numeric), 2) INTO v_total
    FROM jsonb_array_elements(p_items) e
    JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid
    WHERE l.user_id = v_seller_id;

    INSERT INTO public.orders (buyer_id, seller_id, pickup_location_id, total_myr)
    VALUES (p_buyer_id, v_seller_id, p_pickup_location_id, v_total)
    RETURNING id INTO v_order_id;
    v_order_ids := array_append(v_order_ids, v_order_id);

    FOR v_item IN
      SELECT e.value
      FROM jsonb_array_elements(p_items) e
      JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid
      WHERE l.user_id = v_seller_id
    LOOP
      SELECT * INTO v_listing FROM public.listings WHERE id = (v_item->>'listing_id')::uuid;
      SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id;

      UPDATE public.listings
      SET quantity = quantity - 1,
          status = CASE WHEN quantity - 1 = 0 THEN 'reserved' ELSE 'active' END
      WHERE id = v_listing.id;

      INSERT INTO public.order_items (
        order_id, listing_id, library_card_id, quantity, unit_myr, line_myr,
        multiplier, scryfall_id, card_name, set_code, set_name,
        collector_number, foil, condition
      ) VALUES (
        v_order_id, v_listing.id, v_listing.library_card_id, 1,
        (v_item->>'unit_myr')::numeric, (v_item->>'unit_myr')::numeric,
        v_listing.multiplier, v_card.scryfall_id, v_item->>'card_name',
        v_item->>'set_code', v_item->>'set_name', v_item->>'collector_number',
        v_card.foil, v_card.condition
      );
    END LOOP;

    INSERT INTO public.order_events (order_id, actor_id, event_type, to_status)
    VALUES (v_order_id, p_buyer_id, 'checkout_created', 'awaiting_payment');
  END LOOP;

  DELETE FROM public.cart_items ci
  WHERE ci.user_id = p_buyer_id
    AND ci.id IN (SELECT (value->>'cart_item_id')::uuid FROM jsonb_array_elements(p_items));

  UPDATE public.checkout_requests
  SET status = 'completed', order_ids = v_order_ids, completed_at = now()
  WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('order_ids', to_jsonb(v_order_ids), 'idempotent_replay', false);
END $$;

CREATE OR REPLACE FUNCTION public.transition_order(
  p_order_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_from text;
  v_item public.order_items%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  v_from := v_order.status;

  IF p_action = 'preparing_order' AND p_actor_id = v_order.seller_id AND v_from = 'awaiting_payment' THEN
    UPDATE public.orders SET status = 'preparing_order', preparing_order_at = now(), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'payment_received' AND p_actor_id = v_order.seller_id AND v_from = 'preparing_order' THEN
    UPDATE public.orders SET status = 'payment_received', payment_received_at = now(), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'dropped_off' AND p_actor_id = v_order.seller_id AND v_from = 'payment_received' THEN
    UPDATE public.orders SET status = 'dropped_off', dropped_off_at = now(), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'order_completed' AND p_actor_id = v_order.buyer_id AND v_from = 'dropped_off' THEN
    UPDATE public.orders SET status = 'order_completed', completed_at = now(), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id = p_order_id LOOP
      IF v_item.library_card_id IS NOT NULL THEN
        UPDATE public.library_cards SET quantity = quantity - v_item.quantity
        WHERE id = v_item.library_card_id AND quantity > v_item.quantity;
        IF NOT FOUND THEN
          DELETE FROM public.library_cards WHERE id = v_item.library_card_id AND quantity = v_item.quantity;
        END IF;
      END IF;
    END LOOP;
  ELSIF p_action = 'cancel' AND p_actor_id = v_order.seller_id AND v_from NOT IN ('order_completed', 'cancelled') THEN
    IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 500 THEN
      RAISE EXCEPTION 'Cancellation reason must be 5 to 500 characters' USING ERRCODE = '22023';
    END IF;
    UPDATE public.orders SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_id,
      cancellation_reason = btrim(p_reason), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id = p_order_id LOOP
      IF v_item.listing_id IS NULL THEN RAISE EXCEPTION 'Reserved listing cannot be restored' USING ERRCODE = 'P0001'; END IF;
      UPDATE public.listings SET
        quantity = quantity + v_item.quantity,
        status = CASE
          WHEN expires_at > now() AND EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = listings.user_id
              AND p.merchant_profile_completed_at IS NOT NULL
              AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
              AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
              AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)
          ) THEN 'active'
          ELSE 'expired'
        END
      WHERE id = v_item.listing_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Reserved listing cannot be restored' USING ERRCODE = 'P0001'; END IF;
    END LOOP;
    UPDATE public.order_cancellation_requests
      SET resolved_at = now(), resolved_by = p_actor_id, resolution = 'accepted'
      WHERE order_id = p_order_id AND resolved_at IS NULL;
  ELSE
    RAISE EXCEPTION 'Actor is not authorized for this order transition' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.order_events (order_id, actor_id, event_type, from_status, to_status, reason)
  VALUES (p_order_id, p_actor_id, p_action, v_from, v_order.status, nullif(btrim(p_reason), ''));
  RETURN v_order;
END $$;

CREATE OR REPLACE FUNCTION public.request_order_cancellation(
  p_order_id uuid,
  p_actor_id uuid,
  p_reason text
) RETURNS public.order_cancellation_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_request public.order_cancellation_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR p_actor_id <> v_order.buyer_id THEN RAISE EXCEPTION 'Only the buyer can request cancellation' USING ERRCODE = 'P0001'; END IF;
  IF v_order.status IN ('order_completed', 'cancelled') THEN RAISE EXCEPTION 'Order is already final' USING ERRCODE = 'P0001'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 500 THEN RAISE EXCEPTION 'Reason must be 5 to 500 characters' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.order_cancellation_requests (order_id, actor_id, reason)
  VALUES (p_order_id, p_actor_id, btrim(p_reason)) RETURNING * INTO v_request;
  INSERT INTO public.order_events (order_id, actor_id, event_type, from_status, to_status, reason)
  VALUES (p_order_id, p_actor_id, 'cancellation_requested', v_order.status, v_order.status, btrim(p_reason));
  RETURN v_request;
END $$;

CREATE OR REPLACE FUNCTION public.report_order_no_show(
  p_order_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_payment_wait_hours integer,
  p_seller_stale_hours integer
) RETURNS public.order_no_show_reports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_report public.order_no_show_reports%ROWTYPE;
  v_type text;
  v_reported uuid;
  v_eligible timestamptz;
BEGIN
  IF p_payment_wait_hours NOT BETWEEN 1 AND 168 OR p_seller_stale_hours NOT BETWEEN 6 AND 336 THEN
    RAISE EXCEPTION 'No-show thresholds are outside configured safety bounds' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 500 THEN RAISE EXCEPTION 'Reason must be 5 to 500 characters' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;

  IF p_actor_id = v_order.seller_id AND v_order.payment_received_at IS NULL
     AND v_order.status IN ('awaiting_payment', 'preparing_order') THEN
    v_eligible := v_order.created_at + make_interval(hours => p_payment_wait_hours);
    IF now() < v_eligible THEN RAISE EXCEPTION 'Unpaid-buyer report is not eligible yet' USING ERRCODE = 'P0001'; END IF;
    v_type := 'buyer_unpaid'; v_reported := v_order.buyer_id;
  ELSIF p_actor_id = v_order.buyer_id AND v_order.status = 'payment_received'
     AND v_order.payment_received_at IS NOT NULL AND v_order.dropped_off_at IS NULL THEN
    v_eligible := v_order.payment_received_at + make_interval(hours => p_seller_stale_hours);
    IF now() < v_eligible THEN RAISE EXCEPTION 'Seller-stale report is not eligible yet' USING ERRCODE = 'P0001'; END IF;
    v_type := 'seller_stale_after_payment'; v_reported := v_order.seller_id;
  ELSE
    RAISE EXCEPTION 'Actor or order state is not eligible for a no-show report' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.order_no_show_reports (order_id, reporter_id, reported_user_id, report_type, reason, eligible_at)
  VALUES (p_order_id, p_actor_id, v_reported, v_type, btrim(p_reason), v_eligible)
  RETURNING * INTO v_report;
  INSERT INTO public.order_events (order_id, actor_id, event_type, from_status, to_status, reason)
  VALUES (p_order_id, p_actor_id, v_type, v_order.status, v_order.status, btrim(p_reason));
  RETURN v_report;
END $$;

REVOKE ALL ON FUNCTION public.checkout_orders(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_order(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_order_cancellation(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_order_no_show(uuid, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_orders(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_order(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_order_cancellation(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_order_no_show(uuid, uuid, text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.checkout_orders IS 'Service-role-only atomic seller-grouped checkout using trusted server price snapshots.';
COMMENT ON TABLE public.order_no_show_reports IS 'Bounded participant reports; eligibility thresholds are configurable by the server within SQL safety bounds.';
