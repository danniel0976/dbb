-- Phase 45C case 7a regression: the reserved-listing protection invariant.
-- Run only against the disposable local Supabase project after a full reset.
-- This file is transactional and rolls back; it creates its own fixtures.
--
-- The invariant owner is the trigger function public.protect_reserved_listing(),
-- bound to public.listings as listings_protect_active_orders. These are runtime
-- behaviour checks against that owner, not source-string assertions.
--
-- Caller simulation: the tests run in a direct psql session and set the
-- PostgREST request-claims GUC that auth.role() reads. That exercises the exact
-- branch the trigger uses to classify a caller. It does not reproduce the
-- PostgREST transport (where session_user is `authenticator`); the authenticated
-- REST path remains covered by the runtime UAT matrix.

BEGIN;

-- ---------------------------------------------------------------- fixtures
-- Minimal auth.users rows only to satisfy profiles.id -> auth.users. These are
-- never authenticated through GoTrue and are rolled back with the transaction,
-- so the REST-seed token/change-field requirements do not apply here.
INSERT INTO auth.users (id)
VALUES ('a1111111-0000-4000-8000-000000000001'),
       ('a2222222-0000-4000-8000-000000000002');

INSERT INTO public.profiles (id, username, merchant_profile_completed_at, merchant_bank_name,
                             merchant_account_name, merchant_account_number)
VALUES
  ('a1111111-0000-4000-8000-000000000001', 'protect_seller', now(), 'Test Bank', 'Test Seller', '1234567890'),
  ('a2222222-0000-4000-8000-000000000002', 'protect_buyer', now(), 'Test Bank', 'Test Buyer', '0987654321')
ON CONFLICT (id) DO UPDATE SET
  username = EXCLUDED.username,
  merchant_profile_completed_at = EXCLUDED.merchant_profile_completed_at,
  merchant_bank_name = EXCLUDED.merchant_bank_name,
  merchant_account_name = EXCLUDED.merchant_account_name,
  merchant_account_number = EXCLUDED.merchant_account_number;

INSERT INTO public.binders (id, user_id, name)
VALUES ('bbbbbbbb-0000-4000-8000-000000000001',
        'a1111111-0000-4000-8000-000000000001', 'Protect Test Binder');

INSERT INTO public.card_index (scryfall_id, name, set_code, collector_number)
VALUES ('cccccccc-0000-4000-8000-000000000001', 'Protect Test Card', 'tst', '001');

INSERT INTO public.library_cards (id, user_id, binder_id, scryfall_id, quantity)
VALUES ('dddddddd-0000-4000-8000-000000000001',
        'a1111111-0000-4000-8000-000000000001',
        'bbbbbbbb-0000-4000-8000-000000000001',
        'cccccccc-0000-4000-8000-000000000001', 10);

INSERT INTO public.pickup_locations (id, slug, name, address)
VALUES ('eeeeeeee-0000-4000-8000-000000000001', 'protect-test', 'Protect Test', 'Test Address');

INSERT INTO public.listings (id, user_id, library_card_id, multiplier, quantity, expires_at, status)
VALUES ('ffffffff-0000-4000-8000-000000000001',
        'a1111111-0000-4000-8000-000000000001',
        'dddddddd-0000-4000-8000-000000000001',
        2.5, 5, now() + interval '24 hours', 'active');

INSERT INTO public.orders (id, buyer_id, seller_id, pickup_location_id, status, total_myr)
VALUES ('99999999-0000-4000-8000-000000000001',
        'a2222222-0000-4000-8000-000000000002',
        'a1111111-0000-4000-8000-000000000001',
        'eeeeeeee-0000-4000-8000-000000000001', 'awaiting_payment', 10.00);

INSERT INTO public.order_items (id, order_id, listing_id, library_card_id, quantity,
                                unit_myr, line_myr, scryfall_id, card_name)
VALUES ('88888888-0000-4000-8000-000000000001',
        '99999999-0000-4000-8000-000000000001',
        'ffffffff-0000-4000-8000-000000000001',
        'dddddddd-0000-4000-8000-000000000001',
        1, 10.00, 10.00, 'cccccccc-0000-4000-8000-000000000001', 'Protect Test Card');

-- Guard: an untriggered fixture would make every case below vacuous.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.listing_id = 'ffffffff-0000-4000-8000-000000000001'
      AND o.status NOT IN ('order_completed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'case7a fixture: listing is not reserved by an active order';
  END IF;
END $$;

-- ------------------------------------------- case 1: authenticated UPDATE blocked
DO $$
DECLARE v_blocked boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1111111-0000-4000-8000-000000000001"}', true);
  BEGIN
    UPDATE public.listings SET quantity = 1 WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Listing is reserved by an active order' THEN RAISE; END IF;
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'case7a-1 FAIL: authenticated seller mutated a listing reserved by an active order';
  END IF;
END $$;

-- ------------------------------------------- case 2: authenticated DELETE blocked
DO $$
DECLARE v_blocked boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1111111-0000-4000-8000-000000000001"}', true);
  BEGIN
    DELETE FROM public.listings WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'case7a-2 FAIL: authenticated seller unlisted a listing reserved by an active order';
  END IF;
END $$;

-- ------------------------------------------- case 3: anon is also blocked (fail-closed)
DO $$
DECLARE v_blocked boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    UPDATE public.listings SET quantity = 1 WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'case7a-3 FAIL: anon caller mutated a reserved listing';
  END IF;
END $$;

-- ------------------------------------------- case 4: service_role still permitted
DO $$
DECLARE v_qty integer;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  UPDATE public.listings SET quantity = 4 WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  SELECT quantity INTO v_qty FROM public.listings WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  IF v_qty <> 4 THEN
    RAISE EXCEPTION 'case7a-4 FAIL: service_role write did not apply (quantity=%)', v_qty;
  END IF;
END $$;

-- ------------------------------- case 5: direct backend session still permitted
-- Restore/expiry/migration paths run without a PostgREST request context.
DO $$
DECLARE v_qty integer;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.listings SET quantity = 5 WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  SELECT quantity INTO v_qty FROM public.listings WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  IF v_qty <> 5 THEN
    RAISE EXCEPTION 'case7a-5 FAIL: direct backend session write did not apply (quantity=%)', v_qty;
  END IF;
END $$;

-- ------------- case 6: no over-blocking once the order reaches a terminal state
DO $$
DECLARE v_qty integer;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.orders SET status = 'cancelled' WHERE id = '99999999-0000-4000-8000-000000000001';

  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1111111-0000-4000-8000-000000000001"}', true);
  UPDATE public.listings SET quantity = 7 WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  SELECT quantity INTO v_qty FROM public.listings WHERE id = 'ffffffff-0000-4000-8000-000000000001';
  IF v_qty <> 7 THEN
    RAISE EXCEPTION 'case7a-6 FAIL: seller blocked after the order became terminal (quantity=%)', v_qty;
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.orders SET status = 'awaiting_payment' WHERE id = '99999999-0000-4000-8000-000000000001';
END $$;

-- ------------------------------------------------- case 7: anti-vacuity control
-- Reinstate the defective definer-context bypass and prove these tests detect it.
-- A harness that still "passes" here would be measuring nothing.
DO $$
DECLARE v_leaked boolean := false;
BEGIN
  CREATE OR REPLACE FUNCTION public.protect_reserved_listing()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $defect$
  BEGIN
    IF current_user IN ('postgres', 'service_role')
       OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
      WHERE oi.listing_id = OLD.id AND o.status NOT IN ('order_completed', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'Listing is reserved by an active order' USING ERRCODE = 'P0001';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END $defect$;

  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1111111-0000-4000-8000-000000000001"}', true);
  BEGIN
    UPDATE public.listings SET quantity = 2 WHERE id = 'ffffffff-0000-4000-8000-000000000001';
    v_leaked := true;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_leaked := false;
  END;

  IF NOT v_leaked THEN
    RAISE EXCEPTION 'case7a-7 FAIL: anti-vacuity control did not reproduce the defect; these tests prove nothing';
  END IF;
END $$;

-- The defective definition from case 7 exists only inside this transaction.
ROLLBACK;

SELECT 'PHASE45C_PROTECT_RESERVED_LISTING_PASS' AS result;
