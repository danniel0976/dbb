-- Phase 45C deterministic structural/RPC checks. Run only after a disposable
-- reset with the complete migration chain; this file is transactional.
BEGIN;

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
  FROM (VALUES
    ('cart_items.quantity'), ('cart_items.updated_at'), ('cart_items.version'),
    ('checkout_requests.request_fingerprint')
  ) AS expected(name)
  WHERE split_part(name, '.', 1) NOT IN (
    SELECT table_name FROM information_schema.tables WHERE table_schema='public'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=split_part(name,'.',1)
      AND c.column_name=split_part(name,'.',2)
  );
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing Phase 45C columns: %', missing; END IF;
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.phase45c_cart_add(uuid,uuid,integer)') IS NULL
    OR to_regprocedure('public.phase45c_cart_update(uuid,uuid,integer,bigint)') IS NULL
    OR to_regprocedure('public.phase45c_cart_delete(uuid,uuid)') IS NULL
    OR to_regprocedure('public.checkout_orders(uuid,uuid,uuid,jsonb,text)') IS NULL
    OR to_regprocedure('public.transition_order(uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Phase 45C RPC set is incomplete';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'claim_sales'
      AND policyname = 'owner claim_sales crud'
  ) THEN
    RAISE EXCEPTION 'Claim Sale owner CRUD policy remains active';
  END IF;

  IF has_table_privilege('authenticated', 'public.claim_sales', 'INSERT')
    OR has_table_privilege('authenticated', 'public.claim_sales', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.claim_sales', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated Claim Sale DML privilege remains granted';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.claim_sales', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated Claim Sale SELECT privilege was removed';
  END IF;
END $$;

-- Deterministic source-level gates for the barrier matrix. The actual two
-- session executions must still be run against a disposable database; these
-- assertions prevent a migration from silently dropping the lock/rollback
-- boundaries that those barriers exercise.
DO $$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef('public.checkout_orders(uuid,uuid,uuid,jsonb,text)'::regprocedure) INTO src;
  IF src NOT LIKE '%phase45c_lock_buyer%' OR src NOT LIKE '%CART_STALE%'
    OR src NOT LIKE '%ORDER BY value->>''listing_id''%' OR src NOT LIKE '%multiplier%'
    THEN RAISE EXCEPTION 'checkout barrier/snapshot/price contract missing'; END IF;
  IF position('\\.' IN src) > 0 OR position('(\.' IN src) = 0 THEN
    RAISE EXCEPTION 'checkout decimal price/multiplier regex is over-escaped or missing';
  END IF;
  IF src NOT LIKE '%jsonb_typeof(value->''quantity'') <> ''number''%'
    OR src NOT LIKE '%LISTING_CARD_OWNER_MISMATCH%'
    OR src NOT LIKE '%!~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-5]%'
    THEN RAISE EXCEPTION 'checkout JSON/ownership gates missing'; END IF;
  SELECT pg_get_functiondef('public.phase45c_lock_buyer(uuid)'::regprocedure) INTO src;
  IF src NOT LIKE '%phase45c:buyer:%' THEN
    RAISE EXCEPTION 'buyer advisory-lock helper contract missing';
  END IF;
  SELECT pg_get_functiondef('public.phase45c_lock_claim_sale_resources(uuid)'::regprocedure) INTO src;
  IF src NOT LIKE '%ORDER BY id FOR UPDATE%' OR src NOT LIKE '%claim_sales WHERE id%'
    OR src NOT LIKE '%ORDER BY library_card_id, source_id FOR UPDATE%' THEN
    RAISE EXCEPTION 'Claim Sale listing-parent-card-reservation hierarchy missing';
  END IF;
  SELECT pg_get_functiondef('public.phase45c_claim_sale_status_sync()'::regprocedure) INTO src;
  IF src LIKE '%FOR UPDATE%' OR src LIKE '%marketplace_card_reservations%' THEN
    RAISE EXCEPTION 'Claim Sale status trigger reacquires child locks';
  END IF;
  SELECT pg_get_functiondef('public.transition_order(uuid,uuid,text,text)'::regprocedure) INTO src;
  IF src NOT LIKE '%ORDER_NOT_AUTHORIZED%' OR src NOT LIKE '%ORDER BY l.id%'
    OR src NOT LIKE '%ORDER BY lc.id%' OR src NOT LIKE '%ORDER BY m.library_card_id, m.source_id%'
    OR src NOT LIKE '%WHERE id = p_order_id FOR UPDATE%'
    OR src NOT LIKE '%LISTING_CARD_OWNER_MISMATCH%' OR src NOT LIKE '%phase45c_claim_sale_eligible%'
    OR src NOT LIKE '%ORDER_NOT_FOUND%' OR src NOT LIKE '%LISTING_NOT_FOUND%'
    OR src NOT LIKE '%INVALID_CANCELLATION_REASON%' OR src NOT LIKE '%ORDER_TRANSITION_NOT_ALLOWED%'
    OR src NOT LIKE '%auction_bid%' OR src NOT LIKE '%auction_buyout%' OR src NOT LIKE '%relist_available%'
    THEN RAISE EXCEPTION 'terminal transition lock/auth/auction reconciliation contract missing'; END IF;
  IF position('ORDER_NOT_AUTHORIZED' IN src) > position('v_from = ''order_completed''' IN src) THEN
    RAISE EXCEPTION 'terminal authorization occurs after idempotent replay';
  END IF;
  IF to_regprocedure('public.phase45c_cancel_claim_sale(uuid,uuid)') IS NULL
    OR to_regprocedure('public.phase45c_claim_sale_status_sync()') IS NULL
    OR to_regprocedure('public.phase45c_reconcile_expired_listings(integer)') IS NULL
    THEN RAISE EXCEPTION 'Claim Sale atomic lifecycle contract missing'; END IF;
END $$;

-- Malformed direct RPC payloads must fail before the idempotency insert or any
-- row lock that could become a write. These cases deliberately use a missing
-- pickup UUID: payload validation must win and remain stable.
DO $$
DECLARE
  v_payloads jsonb[] := ARRAY[
    '{"not":"an array"}'::jsonb,
    '[{"cart_item_id":"00000000-0000-0000-0000-000000000000","listing_id":"bad","quantity":1,"unit_myr":1,"multiplier":2.5}]'::jsonb,
    '[{"cart_item_id":"00000000-0000-4000-8000-000000000001","listing_id":"00000000-0000-4000-8000-000000000002","quantity":"1","unit_myr":1,"multiplier":2.5}]'::jsonb,
    '[{"cart_item_id":"00000000-0000-4000-8000-000000000001","listing_id":"00000000-0000-4000-8000-000000000002","quantity":999999999999999999999999,"unit_myr":1,"multiplier":2.5}]'::jsonb
  ];
  v_payload jsonb;
  v_message text;
BEGIN
  FOREACH v_payload IN ARRAY v_payloads LOOP
    BEGIN
      PERFORM public.checkout_orders(
        '00000000-0000-4000-8000-000000000001'::uuid,
        gen_random_uuid(), '00000000-0000-4000-8000-000000000099'::uuid,
        v_payload, 'malformed-test'
      );
      RAISE EXCEPTION 'malformed checkout payload was accepted: %', v_payload;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message <> 'CART_SNAPSHOT_INVALID' THEN
        RAISE EXCEPTION 'malformed checkout payload leaked unstable error: %', v_message;
      END IF;
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.cart_items', 'INSERT')
    OR has_table_privilege('authenticated', 'public.cart_items', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.cart_items', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated cart DML remains granted';
  END IF;
  IF has_table_privilege('authenticated', 'public.marketplace_card_reservations', 'SELECT')
    OR has_table_privilege('anon', 'public.marketplace_card_reservations', 'SELECT') THEN
    RAISE EXCEPTION 'reservation table is client-readable';
  END IF;
  IF has_function_privilege('authenticated', 'public.checkout_orders(uuid,uuid,uuid,jsonb,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.phase45c_cart_add(uuid,uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'client can execute service-only cart/checkout RPC';
  END IF;
END $$;

DO $$
DECLARE bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
  FROM public.marketplace_card_reservations mcr
  JOIN public.library_cards lc ON lc.id=mcr.library_card_id
  GROUP BY mcr.library_card_id, lc.quantity
  HAVING sum(mcr.reserved_quantity) > lc.quantity;
  IF bad_count > 0 THEN RAISE EXCEPTION 'reservation invariant violated for % card(s)', bad_count; END IF;
END $$;

ROLLBACK;
