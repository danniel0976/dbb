-- Forward reconciliation for hosts where the Phase 45B Auction migration was
-- applied after the Phase 45C cart hardening function.  45B's historical
-- CREATE OR REPLACE body includes Auction cancellation branches but replaces
-- the later terminal lock/auth/ownership contract.  Keep the complete Phase
-- 45C body here (including those Auction branches) so either upgrade order
-- converges on one safe implementation.

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
