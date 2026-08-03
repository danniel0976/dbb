-- Phase 45C: bind Auction checkout idempotency keys to immutable intent.
--
-- checkout_requests is shared by cart and Auction checkout.  A completed key
-- may replay only when its action, buyer, auction, and pickup location are the
-- exact same immutable request.  Do not modify the recorded Phase 45B RPC
-- migration: this contract migration replaces those functions in place.

CREATE OR REPLACE FUNCTION public.phase45c_auction_checkout_fingerprint(
  p_action text, p_buyer_id uuid, p_auction_id uuid, p_pickup_location_id uuid
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT 'auction-checkout:v1:' || p_action || ':' || p_buyer_id::text || ':' ||
    p_auction_id::text || ':' || p_pickup_location_id::text
$$;

CREATE OR REPLACE FUNCTION public.checkout_auction_buyout(
  p_buyer_id uuid, p_idempotency_key uuid, p_pickup_location_id uuid, p_auction_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a public.auctions%ROWTYPE;
  v_req public.checkout_requests%ROWTYPE;
  v_order uuid;
  v_i public.auction_items%ROWTYPE;
  v_count integer;
  v_total_sen bigint;
  v_alloc record;
  v_v uuid[] := '{}';
  v_fingerprint text;
BEGIN
  IF p_buyer_id IS NULL OR p_idempotency_key IS NULL OR
     p_pickup_location_id IS NULL OR p_auction_id IS NULL THEN
    RAISE EXCEPTION 'CHECKOUT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  v_fingerprint := public.phase45c_auction_checkout_fingerprint(
    'buyout', p_buyer_id, p_auction_id, p_pickup_location_id
  );
  INSERT INTO public.checkout_requests(buyer_id, idempotency_key, request_fingerprint)
  VALUES(p_buyer_id, p_idempotency_key, v_fingerprint)
  ON CONFLICT (buyer_id, idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO v_req FROM public.checkout_requests
    WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key FOR UPDATE;
    IF v_req.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = 'P0001';
    END IF;
    IF v_req.status = 'completed' THEN
      RETURN jsonb_build_object('result_code', coalesce(v_req.result_code, 'CHECKOUT_COMPLETE'), 'order_ids', to_jsonb(v_req.order_ids));
    END IF;
    RAISE EXCEPTION 'CHECKOUT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_a FROM public.auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_a.status = 'active' AND v_a.expires_at <= now() THEN
    IF v_a.bid_count = 0 THEN
      UPDATE public.auctions SET status = 'expired' WHERE id = p_auction_id;
      DELETE FROM public.marketplace_card_reservations WHERE source_kind = 'auction' AND source_id = p_auction_id;
    ELSE
      SELECT bidder_id INTO v_a.winner_id FROM public.auction_bids WHERE id = v_a.current_bid_id;
      UPDATE public.auctions SET status = 'ended_pending_winner', winner_id = v_a.winner_id, won_at = v_a.expires_at WHERE id = p_auction_id;
    END IF;
    UPDATE public.checkout_requests SET status = 'completed', result_code = 'AUCTION_ENDED', order_ids = '{}', completed_at = now()
    WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('result_code', 'AUCTION_ENDED', 'order_ids', '[]'::jsonb);
  END IF;
  IF v_a.status <> 'active' OR v_a.expires_at <= now() THEN RAISE EXCEPTION 'AUCTION_ENDED' USING ERRCODE = 'P0001'; END IF;
  IF v_a.buyout_myr IS NULL THEN RAISE EXCEPTION 'BUYOUT_UNAVAILABLE' USING ERRCODE = 'P0001'; END IF;
  IF p_buyer_id = v_a.seller_id THEN RAISE EXCEPTION 'SELLER_CANNOT_BUY' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pickup_locations WHERE id = p_pickup_location_id AND active) THEN RAISE EXCEPTION 'PICKUP_UNAVAILABLE' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id = v_a.seller_id AND p.merchant_profile_completed_at IS NOT NULL AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_count FROM public.auction_items WHERE auction_id = p_auction_id;
  v_total_sen := v_a.buyout_myr::bigint * 100;
  IF v_count = 0 OR v_total_sen < v_count THEN RAISE EXCEPTION 'ALLOCATION_TOO_SMALL' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.orders(buyer_id, seller_id, pickup_location_id, total_myr) VALUES(p_buyer_id, v_a.seller_id, p_pickup_location_id, v_a.buyout_myr) RETURNING id INTO v_order;
  v_v := array_append(v_v, v_order);
  FOR v_alloc IN SELECT * FROM public.phase45_allocate_auction_lines(p_auction_id, v_a.buyout_myr) LOOP
    SELECT * INTO v_i FROM public.auction_items WHERE id = v_alloc.auction_item_id;
    UPDATE public.auction_items SET allocation_weight_myr = v_alloc.allocation_myr WHERE id = v_i.id;
    INSERT INTO public.order_items(order_id, library_card_id, quantity, unit_myr, line_myr, multiplier, price_source, auction_id, auction_item_id, scryfall_id, card_name, set_code, set_name, collector_number, finish, condition)
    VALUES(v_order, v_i.library_card_id, v_i.quantity, (v_alloc.line_sen::numeric / 100) / v_i.quantity, v_alloc.line_sen::numeric / 100, NULL, 'auction_buyout', p_auction_id, v_i.id, v_i.scryfall_id::uuid, v_i.card_name, v_i.set_code, v_i.set_name, v_i.collector_number, v_i.finish, v_i.condition);
  END LOOP;
  UPDATE public.marketplace_card_reservations SET source_kind = 'order', source_id = v_order WHERE source_kind = 'auction' AND source_id = p_auction_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (SELECT count(*) FROM public.auction_items WHERE auction_id = p_auction_id) THEN RAISE EXCEPTION 'RESERVATION_TRANSFER_FAILED' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.auctions SET status = 'ended_sold', winner_id = p_buyer_id, won_at = now(), settled_order_ids = v_v, settled_at = now() WHERE id = p_auction_id;
  INSERT INTO public.order_events(order_id, actor_id, event_type, to_status) VALUES(v_order, p_buyer_id, 'checkout_created', 'awaiting_payment');
  UPDATE public.checkout_requests SET status = 'completed', result_code = 'CHECKOUT_COMPLETE', order_ids = v_v, completed_at = now()
  WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key;
  RETURN jsonb_build_object('result_code', 'CHECKOUT_COMPLETE', 'order_ids', to_jsonb(v_v));
END $$;

CREATE OR REPLACE FUNCTION public.checkout_auction_claim(
  p_winner_id uuid, p_idempotency_key uuid, p_pickup_location_id uuid, p_auction_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a public.auctions%ROWTYPE;
  v_req public.checkout_requests%ROWTYPE;
  v_order uuid;
  v_i public.auction_items%ROWTYPE;
  v_v uuid[] := '{}';
  v_count integer;
  v_total_sen bigint;
  v_alloc record;
  v_fingerprint text;
BEGIN
  IF p_winner_id IS NULL OR p_idempotency_key IS NULL OR
     p_pickup_location_id IS NULL OR p_auction_id IS NULL THEN
    RAISE EXCEPTION 'CHECKOUT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  v_fingerprint := public.phase45c_auction_checkout_fingerprint(
    'claim', p_winner_id, p_auction_id, p_pickup_location_id
  );
  INSERT INTO public.checkout_requests(buyer_id, idempotency_key, request_fingerprint)
  VALUES(p_winner_id, p_idempotency_key, v_fingerprint)
  ON CONFLICT (buyer_id, idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO v_req FROM public.checkout_requests
    WHERE buyer_id = p_winner_id AND idempotency_key = p_idempotency_key FOR UPDATE;
    IF v_req.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = 'P0001';
    END IF;
    IF v_req.status = 'completed' THEN
      RETURN jsonb_build_object('result_code', coalesce(v_req.result_code, 'CHECKOUT_COMPLETE'), 'order_ids', to_jsonb(v_req.order_ids));
    END IF;
    RAISE EXCEPTION 'CHECKOUT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_a FROM public.auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_a.status <> 'ended_pending_winner' OR v_a.winner_id <> p_winner_id THEN RAISE EXCEPTION 'NOT_WINNER' USING ERRCODE = 'P0001'; END IF;
  IF v_a.won_at IS NULL OR v_a.won_at + interval '24 hours' <= now() THEN
    UPDATE public.auctions SET status = 'relist_available' WHERE id = p_auction_id;
    DELETE FROM public.marketplace_card_reservations WHERE source_kind = 'auction' AND source_id = p_auction_id;
    UPDATE public.checkout_requests SET status = 'completed', result_code = 'CLAIM_WINDOW_EXPIRED', order_ids = '{}', completed_at = now()
    WHERE buyer_id = p_winner_id AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('result_code', 'CLAIM_WINDOW_EXPIRED', 'order_ids', '[]'::jsonb);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pickup_locations WHERE id = p_pickup_location_id AND active) THEN RAISE EXCEPTION 'PICKUP_UNAVAILABLE' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id = v_a.seller_id AND p.merchant_profile_completed_at IS NOT NULL AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_count FROM public.auction_items WHERE auction_id = p_auction_id;
  v_total_sen := v_a.current_bid_myr::bigint * 100;
  IF v_count = 0 OR v_total_sen < v_count THEN RAISE EXCEPTION 'ALLOCATION_TOO_SMALL' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.orders(buyer_id, seller_id, pickup_location_id, total_myr) VALUES(p_winner_id, v_a.seller_id, p_pickup_location_id, v_a.current_bid_myr) RETURNING id INTO v_order;
  v_v := array_append(v_v, v_order);
  FOR v_alloc IN SELECT * FROM public.phase45_allocate_auction_lines(p_auction_id, v_a.current_bid_myr) LOOP
    SELECT * INTO v_i FROM public.auction_items WHERE id = v_alloc.auction_item_id;
    UPDATE public.auction_items SET allocation_weight_myr = v_alloc.allocation_myr WHERE id = v_i.id;
    INSERT INTO public.order_items(order_id, library_card_id, quantity, unit_myr, line_myr, multiplier, price_source, auction_id, auction_item_id, scryfall_id, card_name, set_code, set_name, collector_number, finish, condition)
    VALUES(v_order, v_i.library_card_id, v_i.quantity, (v_alloc.line_sen::numeric / 100) / v_i.quantity, v_alloc.line_sen::numeric / 100, NULL, 'auction_bid', p_auction_id, v_i.id, v_i.scryfall_id::uuid, v_i.card_name, v_i.set_code, v_i.set_name, v_i.collector_number, v_i.finish, v_i.condition);
  END LOOP;
  UPDATE public.marketplace_card_reservations SET source_kind = 'order', source_id = v_order WHERE source_kind = 'auction' AND source_id = p_auction_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (SELECT count(*) FROM public.auction_items WHERE auction_id = p_auction_id) THEN RAISE EXCEPTION 'RESERVATION_TRANSFER_FAILED' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.auctions SET status = 'ended_sold', settled_order_ids = v_v, settled_at = now() WHERE id = p_auction_id;
  INSERT INTO public.order_events(order_id, actor_id, event_type, to_status) VALUES(v_order, p_winner_id, 'checkout_created', 'awaiting_payment');
  UPDATE public.checkout_requests SET status = 'completed', result_code = 'CHECKOUT_COMPLETE', order_ids = v_v, completed_at = now()
  WHERE buyer_id = p_winner_id AND idempotency_key = p_idempotency_key;
  RETURN jsonb_build_object('result_code', 'CHECKOUT_COMPLETE', 'order_ids', to_jsonb(v_v));
END $$;

REVOKE ALL ON FUNCTION public.phase45c_auction_checkout_fingerprint(text,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase45c_auction_checkout_fingerprint(text,uuid,uuid,uuid) TO service_role;

COMMENT ON COLUMN public.checkout_requests.request_fingerprint IS
  'Canonical immutable checkout intent binding: buyer/pickup/cart quantities or Auction action/auction/pickup.';
