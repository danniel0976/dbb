-- Phase 45B — service-role auction RPCs.
-- This migration is authored for manual review only. It does not apply SQL to a database.

-- 45A used a boolean auction_items.foil snapshot.  Replace it with the
-- three-valued live-card finish and add the same lossless snapshot to orders.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='auction_items' AND column_name='foil'
  ) THEN
    ALTER TABLE public.auction_items DROP COLUMN foil;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='auction_items' AND column_name='finish'
  ) THEN
    ALTER TABLE public.auction_items ADD COLUMN finish text NOT NULL DEFAULT 'normal';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.auction_items'::regclass
      AND conname='chk_auction_items_finish'
  ) THEN
    ALTER TABLE public.auction_items ADD CONSTRAINT chk_auction_items_finish
      CHECK (finish IN ('normal','foil','etched'));
  END IF;

  IF to_regclass('public.order_items') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='order_items' AND column_name='finish'
    ) THEN
      ALTER TABLE public.order_items ADD COLUMN finish text NOT NULL DEFAULT 'normal';
    END IF;
    -- Preserve the established Phase 39 snapshot for rows created before 45B.
    UPDATE public.order_items
    SET finish = CASE WHEN foil IN ('normal','foil','etched') THEN foil ELSE 'normal' END
    WHERE foil IS NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.order_items'::regclass
        AND conname='chk_order_items_finish'
    ) THEN
      ALTER TABLE public.order_items ADD CONSTRAINT chk_order_items_finish
        CHECK (finish IN ('normal','foil','etched'));
    END IF;
  END IF;
END $$;

-- Preserve the exact terminal outcome for idempotent replay.  The Phase 39
-- checkout_requests shape predates auction lazy-expiry outcomes and only
-- distinguishes processing/completed, so status alone cannot represent an
-- AUCTION_ENDED or CLAIM_WINDOW_EXPIRED completion.
ALTER TABLE public.checkout_requests
  ADD COLUMN IF NOT EXISTS result_code text;

-- Equal-by-quantity allocation.  line_sen is authoritative for order_items;
-- allocation_weight_myr is the whole-MYR line snapshot required by
-- the foundation column.  The one-sen floor is applied before the remainder,
-- so a skewed lot can never generate a zero-value order line.
-- Accepted W3 design warning: allocation_weight_myr is a whole-MYR ceiling
-- snapshot and is intentionally not an exact sen-level price representation.
CREATE OR REPLACE FUNCTION public.phase45_allocate_auction_lines(
  p_auction_id uuid, p_total_myr integer
) RETURNS TABLE(auction_item_id uuid, line_sen bigint, allocation_myr integer)
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH item_base AS (
    SELECT ai.id, ai.quantity::bigint AS quantity,
      (sum(ai.quantity) OVER ())::bigint AS total_quantity,
      (count(*) OVER ())::bigint AS item_count,
      p_total_myr::bigint * 100 AS total_sen,
      row_number() OVER (ORDER BY ai.id) AS rn
    FROM public.auction_items ai
    WHERE ai.auction_id = p_auction_id
  ),
  floored AS (
    SELECT ib.*, (1::bigint + floor(
      ib.quantity::numeric * (ib.total_sen - ib.item_count)
      / NULLIF(ib.total_quantity, 0)
    )::bigint) AS base_sen
    FROM item_base ib
    WHERE ib.total_sen >= ib.item_count
  ),
  remainder AS (
    SELECT f.*, f.total_sen - sum(f.base_sen) OVER () AS remainder_sen
    FROM floored f
  ),
  final_lines AS (
    SELECT r.id AS auction_item_id,
      r.base_sen + CASE WHEN r.rn=1 THEN r.remainder_sen ELSE 0 END AS line_sen
    FROM remainder r
  )
  SELECT fl.auction_item_id, fl.line_sen,
    greatest(1, ceil(fl.line_sen::numeric / 100)::integer) AS allocation_myr
  FROM final_lines fl
  ORDER BY fl.auction_item_id
$$;

-- §4.1 — Draft creation.
CREATE OR REPLACE FUNCTION public.create_auction_draft(
  p_seller_id uuid, p_title text, p_starting_bid_myr integer,
  p_bid_increment text, p_duration_hours integer,
  p_buyout_myr integer DEFAULT NULL,
  p_soft_close_enabled boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_title text;
  v_id uuid;
BEGIN
  v_title := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  IF char_length(v_title) < 3 THEN RAISE EXCEPTION 'TITLE_TOO_SHORT' USING ERRCODE = 'P0001'; END IF;
  IF char_length(v_title) > 60 THEN RAISE EXCEPTION 'TITLE_TOO_LONG' USING ERRCODE = 'P0001'; END IF;
  IF p_bid_increment IS NULL OR p_bid_increment NOT IN ('any','1','5','10') THEN RAISE EXCEPTION 'INVALID_INCREMENT' USING ERRCODE = 'P0001'; END IF;
  IF p_duration_hours IS NULL OR p_duration_hours NOT IN (1,3,6,12,24) THEN RAISE EXCEPTION 'INVALID_DURATION' USING ERRCODE = 'P0001'; END IF;
  IF p_starting_bid_myr IS NULL OR p_starting_bid_myr < 1 THEN RAISE EXCEPTION 'STARTING_BID_TOO_LOW' USING ERRCODE = 'P0001'; END IF;
  IF p_starting_bid_myr > 99999 THEN RAISE EXCEPTION 'STARTING_BID_TOO_HIGH' USING ERRCODE = 'P0001'; END IF;
  IF p_buyout_myr IS NOT NULL AND p_buyout_myr <= p_starting_bid_myr THEN RAISE EXCEPTION 'BUYOUT_MUST_EXCEED_START' USING ERRCODE = 'P0001'; END IF;
  IF p_buyout_myr IS NOT NULL AND p_buyout_myr > 99999 THEN RAISE EXCEPTION 'BUYOUT_TOO_HIGH' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_seller_id AND p.merchant_profile_completed_at IS NOT NULL
      AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
      AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
      AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)
  ) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO public.auctions (seller_id, title, status, starting_bid_myr, buyout_myr,
    bid_increment, duration_hours, soft_close_enabled)
  VALUES (p_seller_id, v_title, 'draft', p_starting_bid_myr, p_buyout_myr,
    p_bid_increment, p_duration_hours, coalesce(p_soft_close_enabled, false))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- §4.1 — Draft update.
CREATE OR REPLACE FUNCTION public.update_auction_draft(
  p_seller_id uuid, p_auction_id uuid, p_title text DEFAULT NULL,
  p_starting_bid_myr integer DEFAULT NULL, p_bid_increment text DEFAULT NULL,
  p_duration_hours integer DEFAULT NULL, p_buyout_myr integer DEFAULT NULL,
  p_soft_close_enabled boolean DEFAULT NULL, p_clear_buyout boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v public.auctions%ROWTYPE;
  v_title text;
  v_start integer;
  v_inc text;
  v_duration integer;
  v_buyout integer;
BEGIN
  SELECT * INTO v FROM public.auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v.seller_id <> p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = 'P0001'; END IF;
  IF v.status <> 'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  v_title := btrim(regexp_replace(coalesce(p_title, v.title), '\s+', ' ', 'g'));
  v_start := coalesce(p_starting_bid_myr, v.starting_bid_myr);
  v_inc := coalesce(p_bid_increment, v.bid_increment);
  v_duration := coalesce(p_duration_hours, v.duration_hours);
  v_buyout := CASE WHEN coalesce(p_clear_buyout, false) THEN NULL
                   ELSE coalesce(p_buyout_myr, v.buyout_myr) END;
  IF char_length(v_title) < 3 THEN RAISE EXCEPTION 'TITLE_TOO_SHORT' USING ERRCODE = 'P0001'; END IF;
  IF char_length(v_title) > 60 THEN RAISE EXCEPTION 'TITLE_TOO_LONG' USING ERRCODE = 'P0001'; END IF;
  IF v_inc NOT IN ('any','1','5','10') THEN RAISE EXCEPTION 'INVALID_INCREMENT' USING ERRCODE = 'P0001'; END IF;
  IF v_duration NOT IN (1,3,6,12,24) THEN RAISE EXCEPTION 'INVALID_DURATION' USING ERRCODE = 'P0001'; END IF;
  IF v_start < 1 THEN RAISE EXCEPTION 'STARTING_BID_TOO_LOW' USING ERRCODE = 'P0001'; END IF;
  IF v_start > 99999 THEN RAISE EXCEPTION 'STARTING_BID_TOO_HIGH' USING ERRCODE = 'P0001'; END IF;
  IF v_buyout IS NOT NULL AND v_buyout <= v_start THEN RAISE EXCEPTION 'BUYOUT_MUST_EXCEED_START' USING ERRCODE = 'P0001'; END IF;
  IF v_buyout IS NOT NULL AND v_buyout > 99999 THEN RAISE EXCEPTION 'BUYOUT_TOO_HIGH' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.auctions SET title = v_title, starting_bid_myr = v_start,
    bid_increment = v_inc, duration_hours = v_duration, buyout_myr = v_buyout,
    soft_close_enabled = coalesce(p_soft_close_enabled, soft_close_enabled)
  WHERE id = p_auction_id;
END $$;

-- §4.1 — Draft lot assembly.
CREATE OR REPLACE FUNCTION public.add_auction_draft_item(
  p_seller_id uuid, p_auction_id uuid, p_library_card_id uuid, p_quantity integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a public.auctions%ROWTYPE;
  v_c public.library_cards%ROWTYPE;
  v_items integer;
  v_copies integer;
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_a.seller_id <> p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = 'P0001'; END IF;
  IF v_a.status <> 'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  IF p_quantity IS NULL OR p_quantity < 1 THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_c FROM public.library_cards WHERE id = p_library_card_id FOR UPDATE;
  IF NOT FOUND OR v_c.user_id <> p_seller_id THEN RAISE EXCEPTION 'CARD_NOT_OWNED' USING ERRCODE = 'P0001'; END IF;
  IF p_quantity > v_c.quantity THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.auction_items WHERE auction_id = p_auction_id AND library_card_id = p_library_card_id) THEN
    RAISE EXCEPTION 'DUPLICATE_LOT_ITEM' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*), coalesce(sum(quantity), 0) INTO v_items, v_copies FROM public.auction_items WHERE auction_id = p_auction_id;
  IF v_items + 1 > 20 THEN RAISE EXCEPTION 'LOT_TOO_MANY_ITEMS' USING ERRCODE = 'P0001'; END IF;
  IF v_copies + p_quantity > 100 THEN RAISE EXCEPTION 'LOT_TOO_MANY_COPIES' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.card_photos WHERE library_card_id = p_library_card_id) THEN
    RAISE EXCEPTION 'PHOTO_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- card_name is NOT NULL in the 45A shape, so draft rows carry the current catalog name.
  INSERT INTO public.auction_items (auction_id, library_card_id, quantity, card_name)
  SELECT p_auction_id, v_c.id, p_quantity, ci.name
  FROM public.card_index ci WHERE ci.scryfall_id = v_c.scryfall_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARD_NOT_OWNED' USING ERRCODE = 'P0001'; END IF;
END $$;

-- Free draft editing: remove an existing item or replace its quantity.
DROP FUNCTION IF EXISTS public.remove_auction_draft_item(uuid, uuid);
CREATE OR REPLACE FUNCTION public.remove_auction_draft_item(
  p_seller_id uuid, p_auction_id uuid, p_library_card_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_a public.auctions%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.seller_id<>p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE='P0001'; END IF;
  IF v_a.status<>'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE='P0001'; END IF;
  DELETE FROM public.auction_items WHERE auction_id=p_auction_id AND library_card_id=p_library_card_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'LOT_ITEM_NOT_FOUND' USING ERRCODE='P0001'; END IF;
END $$;

DROP FUNCTION IF EXISTS public.update_auction_draft_item(uuid, uuid, integer);
CREATE OR REPLACE FUNCTION public.update_auction_draft_item(
  p_seller_id uuid, p_auction_id uuid, p_library_card_id uuid, p_quantity integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_a public.auctions%ROWTYPE; v_c public.library_cards%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.seller_id<>p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE='P0001'; END IF;
  IF v_a.status<>'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE='P0001'; END IF;
  IF p_quantity IS NULL OR p_quantity<1 THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_c FROM public.library_cards WHERE id=p_library_card_id FOR UPDATE;
  IF NOT FOUND OR v_c.user_id<>p_seller_id OR p_quantity>v_c.quantity THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE='P0001'; END IF;
  UPDATE public.auction_items SET quantity=p_quantity
  WHERE auction_id=p_auction_id AND library_card_id=p_library_card_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'LOT_ITEM_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF (SELECT coalesce(sum(quantity),0) FROM public.auction_items WHERE auction_id=p_auction_id)>100 THEN
    RAISE EXCEPTION 'LOT_TOO_MANY_COPIES' USING ERRCODE='P0001';
  END IF;
END $$;

-- §4.1 — Atomic draft publish and reservation.
CREATE OR REPLACE FUNCTION public.publish_auction(p_seller_id uuid, p_auction_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a public.auctions%ROWTYPE;
  v_i public.auction_items%ROWTYPE;
  v_c public.library_cards%ROWTYPE;
  v_now timestamptz := now();
  v_exp timestamptz;
  v_items integer;
  v_copies integer;
  v_reserved integer;
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_a.seller_id <> p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = 'P0001'; END IF;
  IF v_a.status <> 'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*), coalesce(sum(quantity),0) INTO v_items, v_copies FROM public.auction_items WHERE auction_id = p_auction_id;
  IF v_items = 0 THEN RAISE EXCEPTION 'NO_LOT_ITEMS' USING ERRCODE = 'P0001'; END IF;
  IF v_items > 20 THEN RAISE EXCEPTION 'LOT_TOO_MANY_ITEMS' USING ERRCODE = 'P0001'; END IF;
  IF v_copies > 100 THEN RAISE EXCEPTION 'LOT_TOO_MANY_COPIES' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.auction_items WHERE auction_id = p_auction_id GROUP BY library_card_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'DUPLICATE_LOT_ITEM' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = p_seller_id AND p.merchant_profile_completed_at IS NOT NULL
      AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL
      AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)
  ) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE = 'P0001'; END IF;

  -- Deterministic card lock order is the concurrency boundary for inventory.
  FOR v_c IN SELECT lc.* FROM public.library_cards lc JOIN public.auction_items ai ON ai.library_card_id = lc.id
    WHERE ai.auction_id = p_auction_id ORDER BY lc.id FOR UPDATE LOOP NULL; END LOOP;
  FOR v_i IN SELECT * FROM public.auction_items WHERE auction_id = p_auction_id ORDER BY library_card_id NULLS LAST LOOP
    IF v_i.library_card_id IS NULL THEN RAISE EXCEPTION 'CARD_NOT_OWNED' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_c FROM public.library_cards WHERE id = v_i.library_card_id FOR UPDATE;
    IF NOT FOUND OR v_c.user_id <> p_seller_id THEN RAISE EXCEPTION 'CARD_NOT_OWNED' USING ERRCODE = 'P0001'; END IF;
    IF v_i.quantity < 1 OR v_i.quantity > v_c.quantity THEN RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.card_photos WHERE library_card_id = v_c.id) THEN RAISE EXCEPTION 'PHOTO_REQUIRED' USING ERRCODE = 'P0001'; END IF;
    SELECT coalesce(sum(reserved_quantity),0) INTO v_reserved FROM public.marketplace_card_reservations WHERE library_card_id = v_c.id;
    IF v_reserved + v_i.quantity > v_c.quantity THEN RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.auction_items ai SET scryfall_id = v_c.scryfall_id::text,
      card_name = ci.name, set_code = ci.set_code, set_name = ci.set_name,
      collector_number = ci.collector_number, finish = v_c.foil,
      condition = v_c.condition, language = v_c.language,
      allocation_weight_myr = NULL
    FROM public.card_index ci WHERE ai.id = v_i.id AND ci.scryfall_id = v_c.scryfall_id;
    BEGIN
      INSERT INTO public.marketplace_card_reservations
        (library_card_id, owner_id, source_kind, source_id, reserved_quantity)
      VALUES (v_c.id, p_seller_id, 'auction', p_auction_id, v_i.quantity);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE = 'P0001';
    END;
  END LOOP;
  v_exp := v_now + make_interval(hours => v_a.duration_hours);
  UPDATE public.auctions SET status='active', published_at=v_now, expires_at=v_exp, original_expires_at=v_exp
  WHERE id = p_auction_id;
  RETURN jsonb_build_object('auction_id', p_auction_id, 'expires_at', v_exp,
    'item_count', v_items, 'total_quantity', v_copies);
END $$;

-- §4.2 — Bid placement, soft close, and lazy expiry.
CREATE OR REPLACE FUNCTION public.place_auction_bid(
  p_auction_id uuid, p_bidder_id uuid, p_amount_myr integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a public.auctions%ROWTYPE;
  v_floor integer;
  v_step integer;
  v_bid uuid;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.status='active' AND v_a.expires_at <= v_now THEN
    IF v_a.bid_count=0 THEN
      UPDATE public.auctions SET status='expired' WHERE id=p_auction_id;
      DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=p_auction_id;
    ELSE
      SELECT bidder_id INTO v_a.winner_id FROM public.auction_bids WHERE id=v_a.current_bid_id;
      UPDATE public.auctions SET status='ended_pending_winner', winner_id=v_a.winner_id, won_at=v_a.expires_at WHERE id=p_auction_id;
    END IF;
    RETURN jsonb_build_object('result_code','AUCTION_ENDED','auction_id',p_auction_id,
      'status',CASE WHEN v_a.bid_count=0 THEN 'expired' ELSE 'ended_pending_winner' END);
  END IF;
  IF v_a.status <> 'active' OR v_a.expires_at <= v_now THEN RAISE EXCEPTION 'AUCTION_ENDED' USING ERRCODE='P0001'; END IF;
  IF p_bidder_id = v_a.seller_id THEN RAISE EXCEPTION 'SELLER_CANNOT_BID' USING ERRCODE='P0001'; END IF;
  IF p_amount_myr IS NULL OR p_amount_myr < 1 THEN RAISE EXCEPTION 'FRACTIONAL_AMOUNT' USING ERRCODE='P0001'; END IF;
  v_step := CASE v_a.bid_increment WHEN '5' THEN 5 WHEN '10' THEN 10 ELSE 1 END;
  v_floor := CASE WHEN v_a.bid_count=0 THEN v_a.starting_bid_myr ELSE v_a.current_bid_myr + v_step END;
  IF v_floor > 99999 OR p_amount_myr > 99999 THEN
    RAISE EXCEPTION 'BID_TOO_HIGH' USING ERRCODE='P0001';
  END IF;
  IF p_amount_myr < v_floor THEN
    RAISE EXCEPTION 'BID_TOO_LOW' USING ERRCODE='P0001', DETAIL=jsonb_build_object('floor',v_floor,'current_bid_myr',v_a.current_bid_myr)::text;
  END IF;
  IF v_a.buyout_myr IS NOT NULL AND p_amount_myr >= v_a.buyout_myr THEN RAISE EXCEPTION 'USE_BUYOUT' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.auction_bids(auction_id,bidder_id,amount_myr) VALUES(p_auction_id,p_bidder_id,p_amount_myr) RETURNING id INTO v_bid;
  UPDATE public.auctions SET current_bid_myr=p_amount_myr,current_bid_id=v_bid,bid_count=bid_count+1,
    expires_at=CASE WHEN soft_close_enabled AND expires_at-v_now <= interval '5 minutes' AND soft_close_extension_minutes < 15 THEN expires_at+interval '5 minutes' ELSE expires_at END,
    soft_close_extension_minutes=CASE WHEN soft_close_enabled AND expires_at-v_now <= interval '5 minutes' AND soft_close_extension_minutes < 15 THEN least(soft_close_extension_minutes+5,15) ELSE soft_close_extension_minutes END
  WHERE id=p_auction_id RETURNING * INTO v_a;
  RETURN jsonb_build_object('bid_id',v_bid,'current_bid_myr',v_a.current_bid_myr,'bid_count',v_a.bid_count,'expires_at',v_a.expires_at,'soft_close_extension_minutes',v_a.soft_close_extension_minutes);
END $$;

-- §4.3 — Buyout checkout and idempotency.
CREATE OR REPLACE FUNCTION public.checkout_auction_buyout(
  p_buyer_id uuid, p_idempotency_key uuid, p_pickup_location_id uuid, p_auction_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_a public.auctions%ROWTYPE; v_req public.checkout_requests%ROWTYPE; v_order uuid; v_i public.auction_items%ROWTYPE;
  v_count integer; v_total_sen bigint; v_alloc record; v_v uuid[]:='{}';
BEGIN
  INSERT INTO public.checkout_requests(buyer_id,idempotency_key) VALUES(p_buyer_id,p_idempotency_key) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN SELECT * INTO v_req FROM public.checkout_requests WHERE buyer_id=p_buyer_id AND idempotency_key=p_idempotency_key FOR UPDATE; IF v_req.status='completed' THEN RETURN jsonb_build_object('result_code',coalesce(v_req.result_code,'CHECKOUT_COMPLETE'),'order_ids',to_jsonb(v_req.order_ids)); END IF; RAISE EXCEPTION 'CHECKOUT_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.status='active' AND v_a.expires_at<=now() THEN
    IF v_a.bid_count=0 THEN UPDATE public.auctions SET status='expired' WHERE id=p_auction_id; DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=p_auction_id;
    ELSE SELECT bidder_id INTO v_a.winner_id FROM public.auction_bids WHERE id=v_a.current_bid_id; UPDATE public.auctions SET status='ended_pending_winner',winner_id=v_a.winner_id,won_at=v_a.expires_at WHERE id=p_auction_id; END IF;
    UPDATE public.checkout_requests SET status='completed',result_code='AUCTION_ENDED',order_ids='{}',completed_at=now()
    WHERE buyer_id=p_buyer_id AND idempotency_key=p_idempotency_key;
    -- Keep lazy-expiry's first terminal response byte-for-byte equivalent to
    -- the idempotent replay response.  There is no order to report here.
    RETURN jsonb_build_object('result_code','AUCTION_ENDED','order_ids','[]'::jsonb);
  END IF;
  IF v_a.status<>'active' OR v_a.expires_at<=now() THEN RAISE EXCEPTION 'AUCTION_ENDED' USING ERRCODE='P0001'; END IF;
  IF v_a.buyout_myr IS NULL THEN RAISE EXCEPTION 'BUYOUT_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
  IF p_buyer_id=v_a.seller_id THEN RAISE EXCEPTION 'SELLER_CANNOT_BUY' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pickup_locations WHERE id=p_pickup_location_id AND active) THEN RAISE EXCEPTION 'PICKUP_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_a.seller_id AND p.merchant_profile_completed_at IS NOT NULL AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE='P0001'; END IF;
  SELECT count(*) INTO v_count FROM public.auction_items WHERE auction_id=p_auction_id;
  v_total_sen := v_a.buyout_myr::bigint * 100;
  IF v_count=0 OR v_total_sen < v_count THEN RAISE EXCEPTION 'ALLOCATION_TOO_SMALL' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.orders(buyer_id,seller_id,pickup_location_id,total_myr) VALUES(p_buyer_id,v_a.seller_id,p_pickup_location_id,v_a.buyout_myr) RETURNING id INTO v_order; v_v:=array_append(v_v,v_order);
  FOR v_alloc IN SELECT * FROM public.phase45_allocate_auction_lines(p_auction_id,v_a.buyout_myr) LOOP
    SELECT * INTO v_i FROM public.auction_items WHERE id=v_alloc.auction_item_id;
    UPDATE public.auction_items SET allocation_weight_myr=v_alloc.allocation_myr WHERE id=v_i.id;
    INSERT INTO public.order_items(order_id,library_card_id,quantity,unit_myr,line_myr,multiplier,price_source,auction_id,auction_item_id,scryfall_id,card_name,set_code,set_name,collector_number,finish,condition)
    VALUES(v_order,v_i.library_card_id,v_i.quantity,(v_alloc.line_sen::numeric/100)/v_i.quantity,v_alloc.line_sen::numeric/100,NULL,'auction_buyout',p_auction_id,v_i.id,v_i.scryfall_id::uuid,v_i.card_name,v_i.set_code,v_i.set_name,v_i.collector_number,v_i.finish,v_i.condition);
  END LOOP;
  UPDATE public.marketplace_card_reservations SET source_kind='order',source_id=v_order WHERE source_kind='auction' AND source_id=p_auction_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (SELECT count(*) FROM public.auction_items WHERE auction_id=p_auction_id) THEN RAISE EXCEPTION 'RESERVATION_TRANSFER_FAILED' USING ERRCODE='P0001'; END IF;
  UPDATE public.auctions SET status='ended_sold',winner_id=p_buyer_id,won_at=now(),settled_order_ids=v_v,settled_at=now() WHERE id=p_auction_id;
  INSERT INTO public.order_events(order_id,actor_id,event_type,to_status) VALUES(v_order,p_buyer_id,'checkout_created','awaiting_payment');
  UPDATE public.checkout_requests SET status='completed',result_code='CHECKOUT_COMPLETE',order_ids=v_v,completed_at=now() WHERE buyer_id=p_buyer_id AND idempotency_key=p_idempotency_key;
  RETURN jsonb_build_object('result_code','CHECKOUT_COMPLETE','order_ids',to_jsonb(v_v));
END $$;

-- §4.6 — Winner claim checkout.
CREATE OR REPLACE FUNCTION public.checkout_auction_claim(
  p_winner_id uuid, p_idempotency_key uuid, p_pickup_location_id uuid, p_auction_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_a public.auctions%ROWTYPE; v_req public.checkout_requests%ROWTYPE; v_order uuid; v_i public.auction_items%ROWTYPE; v_v uuid[]:='{}'; v_count integer; v_total_sen bigint; v_alloc record;
BEGIN
  INSERT INTO public.checkout_requests(buyer_id,idempotency_key) VALUES(p_winner_id,p_idempotency_key) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN SELECT * INTO v_req FROM public.checkout_requests WHERE buyer_id=p_winner_id AND idempotency_key=p_idempotency_key FOR UPDATE; IF v_req.status='completed' THEN RETURN jsonb_build_object('result_code',coalesce(v_req.result_code,'CHECKOUT_COMPLETE'),'order_ids',to_jsonb(v_req.order_ids)); END IF; RAISE EXCEPTION 'CHECKOUT_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.status<>'ended_pending_winner' OR v_a.winner_id<>p_winner_id THEN RAISE EXCEPTION 'NOT_WINNER' USING ERRCODE='P0001'; END IF;
  IF v_a.won_at IS NULL OR v_a.won_at+interval '24 hours'<=now() THEN
    UPDATE public.auctions SET status='relist_available' WHERE id=p_auction_id;
    DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=p_auction_id;
    UPDATE public.checkout_requests SET status='completed',result_code='CLAIM_WINDOW_EXPIRED',order_ids='{}',completed_at=now()
    WHERE buyer_id=p_winner_id AND idempotency_key=p_idempotency_key;
    -- Keep lazy claim expiry's first terminal response byte-for-byte
    -- equivalent to the idempotent replay response.
    RETURN jsonb_build_object('result_code','CLAIM_WINDOW_EXPIRED','order_ids','[]'::jsonb);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pickup_locations WHERE id=p_pickup_location_id AND active) THEN RAISE EXCEPTION 'PICKUP_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_a.seller_id AND p.merchant_profile_completed_at IS NOT NULL AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE='P0001'; END IF;
  SELECT count(*) INTO v_count FROM public.auction_items WHERE auction_id=p_auction_id;
  v_total_sen := v_a.current_bid_myr::bigint * 100;
  IF v_count=0 OR v_total_sen < v_count THEN RAISE EXCEPTION 'ALLOCATION_TOO_SMALL' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.orders(buyer_id,seller_id,pickup_location_id,total_myr) VALUES(p_winner_id,v_a.seller_id,p_pickup_location_id,v_a.current_bid_myr) RETURNING id INTO v_order; v_v:=array_append(v_v,v_order);
  FOR v_alloc IN SELECT * FROM public.phase45_allocate_auction_lines(p_auction_id,v_a.current_bid_myr) LOOP
    SELECT * INTO v_i FROM public.auction_items WHERE id=v_alloc.auction_item_id;
    UPDATE public.auction_items SET allocation_weight_myr=v_alloc.allocation_myr WHERE id=v_i.id;
    INSERT INTO public.order_items(order_id,library_card_id,quantity,unit_myr,line_myr,multiplier,price_source,auction_id,auction_item_id,scryfall_id,card_name,set_code,set_name,collector_number,finish,condition)
    VALUES(v_order,v_i.library_card_id,v_i.quantity,(v_alloc.line_sen::numeric/100)/v_i.quantity,v_alloc.line_sen::numeric/100,NULL,'auction_bid',p_auction_id,v_i.id,v_i.scryfall_id::uuid,v_i.card_name,v_i.set_code,v_i.set_name,v_i.collector_number,v_i.finish,v_i.condition);
  END LOOP;
  UPDATE public.marketplace_card_reservations SET source_kind='order',source_id=v_order WHERE source_kind='auction' AND source_id=p_auction_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (SELECT count(*) FROM public.auction_items WHERE auction_id=p_auction_id) THEN RAISE EXCEPTION 'RESERVATION_TRANSFER_FAILED' USING ERRCODE='P0001'; END IF;
  UPDATE public.auctions SET status='ended_sold',settled_order_ids=v_v,settled_at=now() WHERE id=p_auction_id;
  INSERT INTO public.order_events(order_id,actor_id,event_type,to_status) VALUES(v_order,p_winner_id,'checkout_created','awaiting_payment');
  UPDATE public.checkout_requests SET status='completed',result_code='CHECKOUT_COMPLETE',order_ids=v_v,completed_at=now() WHERE buyer_id=p_winner_id AND idempotency_key=p_idempotency_key;
  RETURN jsonb_build_object('result_code','CHECKOUT_COMPLETE','order_ids',to_jsonb(v_v));
END $$;

-- §4.5 — One-time manual seller extension.
CREATE OR REPLACE FUNCTION public.extend_auction(
  p_auction_id uuid, p_seller_id uuid, p_extension_minutes integer, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.auctions%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v.seller_id<>p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE='P0001'; END IF;
  IF v.status<>'active' OR v.expires_at<=now() THEN RAISE EXCEPTION 'AUCTION_ENDED' USING ERRCODE='P0001'; END IF;
  IF v.extended_at IS NOT NULL THEN
    IF v.extension_idempotency_key = p_idempotency_key THEN
      RETURN jsonb_build_object('expires_at',v.expires_at,'extension_minutes',v.extension_minutes,'extended_at',v.extended_at);
    END IF;
    RAISE EXCEPTION 'EXTENSION_ALREADY_USED' USING ERRCODE='P0001';
  END IF;
  IF p_extension_minutes NOT IN (15,30,60) THEN RAISE EXCEPTION 'INVALID_EXTENSION' USING ERRCODE='P0001'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE='P0001'; END IF;
  UPDATE public.auctions SET expires_at=expires_at+make_interval(mins=>p_extension_minutes),extension_minutes=p_extension_minutes,extended_at=now(),extension_idempotency_key=p_idempotency_key WHERE id=p_auction_id RETURNING * INTO v;
  RETURN jsonb_build_object('expires_at',v.expires_at,'extension_minutes',v.extension_minutes,'extended_at',v.extended_at);
END $$;

-- §4.8 — Relist as a new auction record.
CREATE OR REPLACE FUNCTION public.relist_auction(p_seller_id uuid,p_old_auction_id uuid,p_duration_hours integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old public.auctions%ROWTYPE; v_i public.auction_items%ROWTYPE; v_c public.library_cards%ROWTYPE; v_new uuid; v_exp timestamptz; v_bad jsonb:='[]'; v_reason text; v_name text;
BEGIN
  SELECT * INTO v_old FROM public.auctions WHERE id=p_old_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_old.seller_id<>p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE='P0001'; END IF;
  IF v_old.status NOT IN ('expired','relist_available') THEN RAISE EXCEPTION 'AUCTION_NOT_RELISTABLE' USING ERRCODE='P0001'; END IF;
  IF p_duration_hours NOT IN (1,3,6,12,24) THEN RAISE EXCEPTION 'INVALID_DURATION' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=p_seller_id AND p.merchant_profile_completed_at IS NOT NULL AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE='P0001'; END IF;
  FOR v_c IN SELECT lc.* FROM public.library_cards lc JOIN public.auction_items ai ON ai.library_card_id=lc.id WHERE ai.auction_id=p_old_auction_id ORDER BY lc.id FOR UPDATE LOOP NULL; END LOOP;
  FOR v_i IN SELECT * FROM public.auction_items WHERE auction_id=p_old_auction_id ORDER BY id LOOP
    v_reason:=NULL; v_name:=v_i.card_name;
    SELECT * INTO v_c FROM public.library_cards WHERE id=v_i.library_card_id FOR UPDATE;
    IF NOT FOUND OR v_c.user_id<>p_seller_id THEN v_reason:='missing';
    ELSIF v_c.quantity<v_i.quantity THEN v_reason:='insufficient_quantity';
    ELSIF NOT EXISTS(SELECT 1 FROM public.card_photos WHERE library_card_id=v_c.id) THEN v_reason:='photo_required';
    ELSIF EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE library_card_id=v_c.id AND NOT (source_kind='auction' AND source_id=p_old_auction_id)) THEN v_reason:='already_listed'; END IF;
    IF v_reason IS NOT NULL THEN v_bad:=v_bad||jsonb_build_array(jsonb_build_object('library_card_id',v_i.library_card_id,'card_name',v_name,'requested_quantity',v_i.quantity,'owned_quantity',coalesce(v_c.quantity,0),'reason',v_reason)); END IF;
  END LOOP;
  IF jsonb_array_length(v_bad)>0 THEN RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE='P0001',DETAIL=v_bad::text; END IF;
  -- A stale old-auction reservation can only occur when a sweep was interrupted;
  -- relisting replaces it transactionally with the new source reservation.
  DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=p_old_auction_id;
  v_exp:=now()+make_interval(hours=>p_duration_hours);
  INSERT INTO public.auctions(seller_id,title,status,starting_bid_myr,buyout_myr,bid_increment,duration_hours,published_at,expires_at,original_expires_at,soft_close_enabled,relisted_from_auction_id)
  VALUES(v_old.seller_id,v_old.title,'active',v_old.starting_bid_myr,v_old.buyout_myr,v_old.bid_increment,p_duration_hours,now(),v_exp,v_exp,v_old.soft_close_enabled,p_old_auction_id) RETURNING id INTO v_new;
  FOR v_i IN SELECT * FROM public.auction_items WHERE auction_id=p_old_auction_id ORDER BY library_card_id LOOP
    SELECT * INTO v_c FROM public.library_cards WHERE id=v_i.library_card_id;
    INSERT INTO public.auction_items(auction_id,library_card_id,quantity,scryfall_id,card_name,set_code,set_name,collector_number,finish,condition,language,allocation_weight_myr)
    SELECT v_new,v_c.id,v_i.quantity,v_c.scryfall_id::text,ci.name,ci.set_code,ci.set_name,ci.collector_number,v_c.foil,v_c.condition,v_c.language,NULL
    FROM public.card_index ci WHERE ci.scryfall_id=v_c.scryfall_id;
    INSERT INTO public.marketplace_card_reservations(library_card_id,owner_id,source_kind,source_id,reserved_quantity) VALUES(v_c.id,p_seller_id,'auction',v_new,v_i.quantity);
  END LOOP;
  RETURN v_new;
END $$;

-- §4.6 — Bulk expiry sweep and unclaimed-win demotion.
CREATE OR REPLACE FUNCTION public.settle_expired_auctions(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.auctions%ROWTYPE; v_n integer:=0; v_winner uuid;
BEGIN
  IF p_limit IS NULL OR p_limit<1 THEN RAISE EXCEPTION 'INVALID_LIMIT' USING ERRCODE='P0001'; END IF;
  FOR v IN SELECT * FROM public.auctions WHERE status='active' AND expires_at<=p_now ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    IF v.bid_count=0 THEN UPDATE public.auctions SET status='expired' WHERE id=v.id; DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=v.id;
    ELSE SELECT bidder_id INTO v_winner FROM public.auction_bids WHERE auction_id=v.id ORDER BY amount_myr DESC,created_at ASC,id ASC LIMIT 1; UPDATE public.auctions SET status='ended_pending_winner',winner_id=v_winner,won_at=v.expires_at WHERE id=v.id; END IF; v_n:=v_n+1;
  END LOOP;
  -- Accepted W1 design warning: one invocation applies p_limit independently
  -- to active expiry and unclaimed-win demotion batches.
  FOR v IN SELECT * FROM public.auctions WHERE status='ended_pending_winner' AND won_at+interval '24 hours'<=p_now ORDER BY won_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.auctions SET status='relist_available' WHERE id=v.id; DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=v.id; v_n:=v_n+1;
  END LOOP;
  RETURN v_n;
END $$;

-- §4.9 — Existing order state machine extended for auction completion/cancellation.
CREATE OR REPLACE FUNCTION public.transition_order(p_order_id uuid,p_actor_id uuid,p_action text,p_reason text DEFAULT NULL)
RETURNS public.orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_order public.orders%ROWTYPE; v_from text; v_item public.order_items%ROWTYPE; v_aid uuid;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id=p_order_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0001'; END IF; v_from:=v_order.status;
  IF p_action='preparing_order' AND p_actor_id=v_order.seller_id AND v_from='awaiting_payment' THEN UPDATE public.orders SET status='preparing_order',preparing_order_at=now(),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action='payment_received' AND p_actor_id=v_order.seller_id AND v_from='preparing_order' THEN UPDATE public.orders SET status='payment_received',payment_received_at=now(),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action='dropped_off' AND p_actor_id=v_order.seller_id AND v_from='payment_received' THEN UPDATE public.orders SET status='dropped_off',dropped_off_at=now(),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action='order_completed' AND p_actor_id=v_order.buyer_id AND v_from='dropped_off' THEN
    UPDATE public.orders SET status='order_completed',completed_at=now(),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
    -- Release every order reservation before touching inventory.  The FK is
    -- non-deferrable, so exact-quantity card deletes must come second.
    DELETE FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=p_order_id;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id=p_order_id LOOP
      IF v_item.library_card_id IS NOT NULL THEN UPDATE public.library_cards SET quantity=quantity-v_item.quantity WHERE id=v_item.library_card_id AND quantity>v_item.quantity; IF NOT FOUND THEN DELETE FROM public.library_cards WHERE id=v_item.library_card_id AND quantity=v_item.quantity; END IF; END IF;
    END LOOP;
  ELSIF p_action='cancel' AND p_actor_id=v_order.seller_id AND v_from NOT IN ('order_completed','cancelled') THEN
    IF p_reason IS NULL OR char_length(btrim(p_reason))<5 OR char_length(p_reason)>500 THEN RAISE EXCEPTION 'Cancellation reason must be 5 to 500 characters' USING ERRCODE='22023'; END IF;
    UPDATE public.orders SET status='cancelled',cancelled_at=now(),cancelled_by=p_actor_id,cancellation_reason=btrim(p_reason),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
    DELETE FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=p_order_id;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id=p_order_id LOOP
      IF v_item.price_source IN ('auction_bid','auction_buyout') THEN
        IF v_item.auction_id IS NOT NULL THEN UPDATE public.auctions SET status='relist_available' WHERE id=v_item.auction_id AND status='ended_sold'; END IF;
      ELSE
        IF v_item.listing_id IS NULL THEN RAISE EXCEPTION 'Reserved listing cannot be restored' USING ERRCODE='P0001'; END IF;
        UPDATE public.listings SET quantity=quantity+v_item.quantity,status=CASE WHEN expires_at>now() AND EXISTS (
          SELECT 1 FROM public.profiles p WHERE p.id=listings.user_id AND p.merchant_profile_completed_at IS NOT NULL
            AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL
            AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL
            AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)
        ) THEN 'active' ELSE 'expired' END WHERE id=v_item.listing_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Reserved listing cannot be restored' USING ERRCODE='P0001'; END IF;
      END IF;
    END LOOP;
    UPDATE public.order_cancellation_requests SET resolved_at=now(),resolved_by=p_actor_id,resolution='accepted' WHERE order_id=p_order_id AND resolved_at IS NULL;
  ELSE RAISE EXCEPTION 'Actor is not authorized for this order transition' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.order_events(order_id,actor_id,event_type,from_status,to_status,reason) VALUES(p_order_id,p_actor_id,p_action,v_from,v_order.status,nullif(btrim(p_reason),'')); RETURN v_order;
END $$;

-- Service-role-only execution boundary for every Phase 45B RPC.
REVOKE ALL ON FUNCTION public.create_auction_draft(uuid,text,integer,text,integer,integer,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.update_auction_draft(uuid,uuid,text,integer,text,integer,integer,boolean,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.add_auction_draft_item(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.remove_auction_draft_item(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.update_auction_draft_item(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.publish_auction(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.place_auction_bid(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.checkout_auction_buyout(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.checkout_auction_claim(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.extend_auction(uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.relist_auction(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_expired_auctions(integer,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.transition_order(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.phase45_allocate_auction_lines(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_auction_draft(uuid,text,integer,text,integer,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_auction_draft(uuid,uuid,text,integer,text,integer,integer,boolean,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_auction_draft_item(uuid,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_auction_draft_item(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_auction_draft_item(uuid,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_auction(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.place_auction_bid(uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkout_auction_buyout(uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkout_auction_claim(uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.extend_auction(uuid,uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.relist_auction(uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_expired_auctions(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_order(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.phase45_allocate_auction_lines(uuid,integer) TO service_role;
