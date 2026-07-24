-- Phase 45A foundation SQL tests. Local/disposable Supabase stack only.
-- Never run against a live/shared database. The migration and this file are
-- expected to run in a disposable database transactionally.

BEGIN;

-- ============================================================
-- Fixtures
-- ============================================================
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'phase45-seller@example.test', '{"username":"phase45_seller"}'),
  ('a0000000-0000-4000-8000-000000000002', 'phase45-bidder@example.test', '{"username":"phase45_bidder"}');

INSERT INTO public.card_index (scryfall_id, name, set_code, collector_number)
VALUES
  ('b0000000-0000-4000-8000-000000000001', 'Phase 45 Lot Card One', 'TST', '1'),
  ('b0000000-0000-4000-8000-000000000002', 'Phase 45 Lot Card Two', 'TST', '2');

INSERT INTO public.library_cards (id, user_id, binder_id, scryfall_id, quantity)
VALUES
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   (SELECT id FROM public.binders WHERE user_id = 'a0000000-0000-4000-8000-000000000001'),
   'b0000000-0000-4000-8000-000000000001', 4),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   (SELECT id FROM public.binders WHERE user_id = 'a0000000-0000-4000-8000-000000000001'),
   'b0000000-0000-4000-8000-000000000002', 4);

-- Use existing default pickup location; do not insert a new one (unique constraint on is_default).

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role","sub":"a0000000-0000-4000-8000-000000000001"}', true);

-- One fixture per open order state from phase39_orders.sql. The migration
-- bootstrap must include all four and exclude order_completed/cancelled.
INSERT INTO public.orders
  (id, buyer_id, seller_id, pickup_location_id, status, total_myr)
VALUES
  ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', (SELECT id FROM public.pickup_locations WHERE active LIMIT 1), 'awaiting_payment', 10.00),
  ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', (SELECT id FROM public.pickup_locations WHERE active LIMIT 1), 'preparing_order', 10.00),
  ('f0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', (SELECT id FROM public.pickup_locations WHERE active LIMIT 1), 'payment_received', 10.00),
  ('f0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', (SELECT id FROM public.pickup_locations WHERE active LIMIT 1), 'dropped_off', 10.00);

INSERT INTO public.order_items
  (id, order_id, library_card_id, quantity, unit_myr, line_myr, multiplier,
   price_source, scryfall_id, card_name)
VALUES
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 1, 10.00, 10.00, 1, 'single_multiplier', 'b0000000-0000-4000-8000-000000000001', 'Phase 45 Lot Card One'),
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 1, 10.00, 10.00, 1, 'single_multiplier', 'b0000000-0000-4000-8000-000000000001', 'Phase 45 Lot Card One'),
  ('f1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 1, 10.00, 10.00, 1, 'single_multiplier', 'b0000000-0000-4000-8000-000000000001', 'Phase 45 Lot Card One'),
  ('f1000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001', 1, 10.00, 10.00, 1, 'single_multiplier', 'b0000000-0000-4000-8000-000000000001', 'Phase 45 Lot Card One');

-- ============================================================
-- 1. Tables, columns, and MYR integer types
-- ============================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(tbl, ', ') INTO v_missing
  FROM (VALUES ('marketplace_card_reservations'), ('auctions'), ('auction_items'), ('auction_bids')) AS x(tbl)
  WHERE to_regclass('public.' || tbl) IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'missing expected table(s): %', v_missing; END IF;
END $$;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(tbl || '.' || col, ', ') INTO v_bad
  FROM (VALUES
    ('marketplace_card_reservations','library_card_id'), ('marketplace_card_reservations','owner_id'),
    ('marketplace_card_reservations','source_kind'), ('marketplace_card_reservations','source_id'),
    ('marketplace_card_reservations','reserved_quantity'), ('auctions','starting_bid_myr'),
    ('auctions','buyout_myr'), ('auctions','current_bid_myr'), ('auction_items','allocation_weight_myr'),
    ('auction_bids','amount_myr'), ('order_items','price_source'), ('order_items','auction_id'),
    ('order_items','auction_item_id'), ('follows','auction_id')
  ) AS x(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = x.tbl AND c.column_name = x.col
  );
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'missing expected column(s): %', v_bad; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'auctions' AND column_name IN ('starting_bid_myr','buyout_myr','current_bid_myr'))
        OR (table_name = 'auction_items' AND column_name = 'allocation_weight_myr')
        OR (table_name = 'auction_bids' AND column_name = 'amount_myr'))
      AND data_type <> 'integer'
  ) THEN
    RAISE EXCEPTION 'all Phase 45 MYR amount columns must be integer';
  END IF;
END $$;

-- ============================================================
-- 2. Service-role fixtures and constraint behavior
-- ============================================================
INSERT INTO public.auctions
  (id, seller_id, title, status, starting_bid_myr, duration_hours, published_at, expires_at, original_expires_at)
VALUES
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Phase 45 Test Lot', 'active', 10, 24, now(), now() + interval '24 hours', now() + interval '24 hours');

INSERT INTO public.auction_items (id, auction_id, library_card_id, quantity, card_name)
VALUES ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 1, 'Phase 45 Lot Card One');

DO $$
BEGIN
  BEGIN
    INSERT INTO public.auctions (seller_id, title, starting_bid_myr, duration_hours, soft_close_extension_minutes)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'Bad Soft Close Lot', 5, 24, 6);
    RAISE EXCEPTION 'invalid soft-close increment was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.claim_sales (user_id, title, duration_hours, expires_at, delivery_option)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'ab', 1, now() + interval '1 hour', 'pickup');
    RAISE EXCEPTION 'claim sale title shorter than 3 chars was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.claim_sales (user_id, title, duration_hours, expires_at, delivery_option)
    VALUES ('a0000000-0000-4000-8000-000000000001', repeat('x', 61), 1, now() + interval '1 hour', 'pickup');
    RAISE EXCEPTION 'claim sale title longer than 60 chars was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Reservation composite PK: same card may have different sources, but the
-- same (card, source_id) pair remains unique.
INSERT INTO public.marketplace_card_reservations
  (library_card_id, owner_id, source_kind, source_id, reserved_quantity)
VALUES
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'listing', 'a1000000-0000-4000-8000-000000000001', 1),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'order', 'a1000000-0000-4000-8000-000000000002', 1);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.marketplace_card_reservations
      (library_card_id, owner_id, source_kind, source_id, reserved_quantity)
    VALUES ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'order', 'a1000000-0000-4000-8000-000000000002', 1);
    RAISE EXCEPTION 'duplicate reservation source was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- Exact-one follows: zero and two targets fail; auction-only succeeds.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.follows (follower_id) VALUES ('a0000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'zero-target follow was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.follows (follower_id, followee_id, auction_id)
    VALUES ('a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'two-target follow was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
INSERT INTO public.follows (follower_id, auction_id)
VALUES ('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001');
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.follows
    WHERE follower_id = 'a0000000-0000-4000-8000-000000000002'
      AND auction_id = 'd0000000-0000-4000-8000-000000000001'
      AND followee_id IS NULL AND claim_sale_id IS NULL
  ) THEN
    RAISE EXCEPTION 'single auction_id-only follow was not inserted';
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT count(DISTINCT status) FROM public.orders
      WHERE id IN (
        'f0000000-0000-4000-8000-000000000001',
        'f0000000-0000-4000-8000-000000000002',
        'f0000000-0000-4000-8000-000000000003',
        'f0000000-0000-4000-8000-000000000004'
      )) <> 4 THEN
    RAISE EXCEPTION 'open-order-state fixtures are incomplete';
  END IF;
END $$;

-- NOT VALID source-shape checks exist and remain unvalidated for legacy rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.order_items'::regclass
      AND conname = 'chk_order_items_single_multiplier_no_auction'
      AND NOT convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.order_items'::regclass
      AND conname = 'chk_order_items_auction_no_multiplier'
      AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'order_items source-shape NOT VALID constraints are missing';
  END IF;
END $$;

RESET ROLE;

-- ============================================================
-- 3. Client RLS/grant boundaries
-- ============================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-4000-8000-000000000002"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.auction_bids LIMIT 1;
    RAISE EXCEPTION 'authenticated selected auction_bids directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.auction_bids (auction_id, bidder_id, amount_myr)
    VALUES ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 15);
    RAISE EXCEPTION 'authenticated inserted auction_bids directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.marketplace_card_reservations LIMIT 1;
    RAISE EXCEPTION 'authenticated selected reservations directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.auctions WHERE id = 'd0000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'anon could not browse active auctions';
  END IF;
  BEGIN
    INSERT INTO public.auctions (seller_id, title, starting_bid_myr, duration_hours)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'Anon Write Attempt', 5, 24);
    RAISE EXCEPTION 'anon inserted an auction directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.auction_bids LIMIT 1;
    RAISE EXCEPTION 'anon selected auction_bids directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

ROLLBACK;
-- If this script completes without error, Phase 45A foundation checks passed.
