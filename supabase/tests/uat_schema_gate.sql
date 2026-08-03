-- DBB local UAT schema gate. Run only against the disposable local Supabase
-- project after `supabase db reset --workdir <worktree-root>`.
-- This file must fail closed before any authenticated REST UAT.

BEGIN;

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name)
  INTO v_missing
  FROM (VALUES
    ('profiles'), ('binders'), ('card_index'), ('library_cards'),
    ('listings'), ('cart_items'), ('card_photos'), ('claim_sales'), ('follows'),
    ('orders'), ('order_items'), ('checkout_requests'), ('pickup_locations'),
    ('marketplace_card_reservations'), ('auctions'), ('auction_items'),
    ('auction_bids'), ('fb_export_snapshots'), ('card_hashes')
  ) AS expected(name)
  WHERE to_regclass('public.' || name) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'UAT schema gate: missing public table(s): %', v_missing;
  END IF;
END $$;

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(version, ', ' ORDER BY version)
  INTO v_missing
  FROM (VALUES
    ('20260101000000'),
    ('20260716000000'),
    ('20260717010000'),
    ('20260717011500'),
    ('20260718000000'),
    ('20260724000000'),
    ('20260724000001'),
    ('20260726000000'),
    ('20260726000001'),
    ('20260727000000'),
    ('20260727000001'),
    ('20260803000000'),
    ('20260803000001')
  ) AS expected(version)
  WHERE NOT EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations applied
    WHERE applied.version = expected.version
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'UAT schema gate: missing migration version(s): %', v_missing;
  END IF;

  IF (SELECT count(*) FROM supabase_migrations.schema_migrations) <> 13 THEN
    RAISE EXCEPTION 'UAT schema gate: expected exactly 13 migration versions, found %',
      (SELECT count(*) FROM supabase_migrations.schema_migrations);
  END IF;
END $$;

-- A host that had Phase 45C before historical 45B must converge on the
-- hardened shared function after the forward reconciliation migration.
DO $$
DECLARE
  v_transition text;
BEGIN
  v_transition := regexp_replace(
    pg_get_functiondef('public.transition_order(uuid,uuid,text,text)'::regprocedure),
    '--[^' || chr(10) || ']*', '', 'g'
  );
  IF v_transition !~ 'ORDER_NOT_AUTHORIZED'
    OR v_transition !~ 'ORDER BY l.id'
    OR v_transition !~ 'ORDER BY lc.id'
    OR v_transition !~ 'ORDER BY m.library_card_id, m.source_id'
    OR v_transition !~ 'WHERE id = p_order_id FOR UPDATE'
    OR v_transition !~ 'LISTING_CARD_OWNER_MISMATCH'
    OR v_transition !~ 'phase45c_claim_sale_eligible'
    OR v_transition !~ 'ORDER_NOT_FOUND'
    OR v_transition !~ 'LISTING_NOT_FOUND'
    OR v_transition !~ 'INVALID_CANCELLATION_REASON'
    OR v_transition !~ 'ORDER_TRANSITION_NOT_ALLOWED'
    OR v_transition !~ 'auction_bid'
    OR v_transition !~ 'auction_buyout'
    OR v_transition !~ 'relist_available' THEN
    RAISE EXCEPTION 'UAT schema gate: transition_order reconciliation contract is missing';
  END IF;
  IF strpos(v_transition, 'ORDER_NOT_AUTHORIZED') > strpos(v_transition, 'v_from = ''order_completed''') THEN
    RAISE EXCEPTION 'UAT schema gate: terminal authorization follows replay';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.transition_order(uuid,uuid,text,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.transition_order(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'UAT schema gate: transition_order execution boundary is wrong';
  END IF;
END $$;

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(signature, ', ' ORDER BY signature)
  INTO v_missing
  FROM (VALUES
    ('public.create_auction_draft(uuid,text,integer,text,integer,integer,boolean)'),
    ('public.update_auction_draft(uuid,uuid,text,integer,text,integer,integer,boolean,boolean)'),
    ('public.add_auction_draft_item(uuid,uuid,uuid,integer)'),
    ('public.remove_auction_draft_item(uuid,uuid,uuid)'),
    ('public.update_auction_draft_item(uuid,uuid,uuid,integer)'),
    ('public.publish_auction(uuid,uuid)'),
    ('public.place_auction_bid(uuid,uuid,integer)'),
    ('public.checkout_auction_buyout(uuid,uuid,uuid,uuid)'),
    ('public.checkout_auction_claim(uuid,uuid,uuid,uuid)'),
    ('public.phase45c_auction_checkout_fingerprint(text,uuid,uuid,uuid)'),
    ('public.extend_auction(uuid,uuid,integer,text)'),
    ('public.relist_auction(uuid,uuid,integer)'),
    ('public.settle_expired_auctions(integer,timestamptz)'),
    ('public.transition_order(uuid,uuid,text,text)'),
    ('public.phase45_allocate_auction_lines(uuid,integer)'),
    ('public.phase45c_cart_add(uuid,uuid,integer)'),
    ('public.phase45c_cart_update(uuid,uuid,integer,bigint)'),
    ('public.phase45c_cart_delete(uuid,uuid)'),
    ('public.checkout_orders(uuid,uuid,uuid,jsonb,text)')
  ) AS expected(signature)
  WHERE to_regprocedure(expected.signature) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'UAT schema gate: missing Phase 45 function(s): %', v_missing;
  END IF;
END $$;

-- Auction checkout must bind the actual immutable intent into the shared
-- checkout-request fingerprint.  Check the replacing RPC bodies, not a stale
-- migration comment; a reused key with a changed action, auction, or pickup
-- must fail before a second order/reservation write.
DO $$
DECLARE
  v_buyout text;
  v_claim text;
BEGIN
  v_buyout := regexp_replace(pg_get_functiondef('public.checkout_auction_buyout(uuid,uuid,uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_claim := regexp_replace(pg_get_functiondef('public.checkout_auction_claim(uuid,uuid,uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  IF v_buyout !~ 'phase45c_auction_checkout_fingerprint' OR
     v_claim !~ 'phase45c_auction_checkout_fingerprint' OR
     v_buyout !~ 'request_fingerprint IS DISTINCT FROM v_fingerprint' OR
     v_claim !~ 'request_fingerprint IS DISTINCT FROM v_fingerprint' OR
     v_buyout !~ 'IDEMPOTENCY_KEY_REUSED' OR v_claim !~ 'IDEMPOTENCY_KEY_REUSED' THEN
    RAISE EXCEPTION 'UAT schema gate: Auction checkout idempotency fingerprint contract is missing';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'dan@dbb.test') THEN
    RAISE EXCEPTION 'UAT schema gate: fixed account dan@dbb.test is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.auctions'::regclass
      AND conname = 'chk_auctions_status'
  ) THEN
    RAISE EXCEPTION 'UAT schema gate: auction status constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.library_cards'::regclass
      AND polname = 'own library'
  ) THEN
    RAISE EXCEPTION 'UAT schema gate: library_cards owner RLS policy is missing';
  END IF;
END $$;

-- Reserved-listing protection: assert the actual owner of the invariant, the
-- trigger function, and that its bypass is not decided from the definer context.
DO $$
DECLARE
  v_def  text;
  v_code text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.listings'::regclass
      AND t.tgname = 'listings_protect_active_orders'
      AND NOT t.tgisinternal
      AND p.proname = 'protect_reserved_listing'
  ) THEN
    RAISE EXCEPTION 'UAT schema gate: listings_protect_active_orders trigger is missing or not bound to protect_reserved_listing';
  END IF;

  v_def := pg_get_functiondef('public.protect_reserved_listing()'::regprocedure);
  -- Assert executable code only; a `--` comment must neither trip nor satisfy
  -- these checks.
  v_code := regexp_replace(v_def, '--[^' || chr(10) || ']*', '', 'g');

  -- Inside a SECURITY DEFINER function current_user is the definer, so deciding
  -- the bypass from it disables the protection for every caller (case 7a).
  IF v_code ~ '\mcurrent_user\M' THEN
    RAISE EXCEPTION 'UAT schema gate: protect_reserved_listing must not decide its bypass from current_user';
  END IF;

  IF v_code !~ 'auth\.role\(\)' OR v_code !~ '\msession_user\M' THEN
    RAISE EXCEPTION 'UAT schema gate: protect_reserved_listing must derive the caller from auth.role() and session_user';
  END IF;

  IF v_code !~ 'Listing is reserved by an active order' THEN
    RAISE EXCEPTION 'UAT schema gate: protect_reserved_listing lost its active-order guard';
  END IF;
END $$;

ROLLBACK;

SELECT 'UAT_SCHEMA_GATE_PASS' AS result;
