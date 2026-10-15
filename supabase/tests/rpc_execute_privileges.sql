-- Disposable local Supabase only. Role simulation, not JWT transport UAT.
BEGIN;

-- Complete checkpoint inventory; additions are also checked by the dynamic sweep.
DO $$
DECLARE r record; p oid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.add_auction_draft_item(uuid,uuid,uuid,integer)', false),
    ('public.checkout_auction_buyout(uuid,uuid,uuid,uuid)', false),
    ('public.checkout_auction_claim(uuid,uuid,uuid,uuid)', false),
    ('public.checkout_orders(uuid,uuid,uuid,jsonb,text)', false),
    ('public.checkout_orders(uuid,uuid,uuid,jsonb)', false),
    ('public.create_auction_draft(uuid,text,integer,text,integer,integer,boolean)', false),
    ('public.delete_card_photo_and_invalidate_export(uuid,uuid)', false),
    ('public.enforce_listing_merchant_profile()', true),
    ('public.extend_auction(uuid,uuid,integer,text)', false),
    ('public.handle_new_profile()', true),
    ('public.handle_new_user()', true),
    ('public.import_library_cards(uuid,uuid,jsonb)', false),
    ('public.import_library_cards_once(uuid,uuid,uuid,jsonb)', false),
    ('public.publish_catalog_refresh(uuid,text,text,integer,integer)', false),
    ('public.invalidate_fb_export_snapshot_on_card_details_change()', true),
    ('public.move_library_cards(uuid,uuid,uuid[])', false),
    ('public.phase45_allocate_auction_lines(uuid,integer)', false),
    ('public.phase45c_cancel_claim_sale(uuid,uuid)', false),
    ('public.phase45c_cart_add(uuid,uuid,integer)', false),
    ('public.phase45c_cart_delete(uuid,uuid)', false),
    ('public.phase45c_cart_update(uuid,uuid,integer,bigint)', false),
    ('public.phase45c_claim_sale_eligible(uuid)', false),
    ('public.phase45c_claim_sale_status_sync()', true),
    ('public.phase45c_end_claim_sale(uuid,boolean)', false),
    ('public.phase45c_expire_claim_sale(uuid)', false),
    ('public.phase45c_guard_card_inventory()', true),
    ('public.phase45c_listing_card_owned(uuid)', false),
    ('public.phase45c_lock_buyer(uuid)', false),
    ('public.phase45c_lock_claim_sale_resources(uuid)', false),
    ('public.phase45c_reconcile_expired_listings(integer)', false),
    ('public.phase45c_sync_listing_reservation()', true),
    ('public.place_auction_bid(uuid,uuid,integer)', false),
    ('public.promote_card_photo(uuid,uuid,text)', false),
    ('public.protect_reserved_listing()', true),
    ('public.publish_auction(uuid,uuid)', false),
    ('public.relist_auction(uuid,uuid,integer)', false),
    ('public.remove_auction_draft_item(uuid,uuid,uuid)', false),
    ('public.report_order_no_show(uuid,uuid,text,integer,integer)', false),
    ('public.request_order_cancellation(uuid,uuid,text)', false),
    ('public.save_fb_export_snapshot(uuid,uuid,numeric,numeric,numeric,uuid,text,text,text)', false),
    ('public.settle_expired_auctions(integer,timestamp with time zone)', false),
    ('public.transition_order(uuid,uuid,text,text)', false),
    ('public.update_auction_draft_item(uuid,uuid,uuid,integer)', false),
    ('public.update_auction_draft(uuid,uuid,text,integer,text,integer,integer,boolean,boolean)', false),
    ('public.update_library_card_and_invalidate_export(uuid,uuid,jsonb)', false)
  ) AS expected(signature, is_trigger) LOOP
    p := to_regprocedure(r.signature);
    IF p IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=p AND prosecdef
      AND (prorettype='trigger'::regtype)=r.is_trigger) THEN
      RAISE EXCEPTION 'RPC ACL inventory missing or changed: %', r.signature;
    END IF;
  END LOOP;
  FOR r IN SELECT oid, oid::regprocedure AS signature, proacl, proowner FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND prosecdef LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', r.oid, 'EXECUTE')
      OR NOT has_function_privilege('service_role', r.oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM aclexplode(coalesce(r.proacl, acldefault('f',r.proowner)))
        WHERE grantee=0 AND privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'RPC effective privilege boundary failed: %', r.signature;
    END IF;
  END LOOP;
END $$;

-- Signup inserts must still create both profile and default binder without
-- direct anon/authenticated EXECUTE grants. SQL trigger proof, not GoTrue UAT.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('e9000000-0000-4000-8000-000000000001', 'rpc-owner@dbb.test', '{"username":"rpc_owner"}'),
  ('e9000000-0000-4000-8000-000000000002', 'rpc-other@dbb.test', '{"username":"rpc_other"}');
DO $$ BEGIN
  IF (SELECT count(*) FROM public.profiles WHERE id IN
      ('e9000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000002')) <> 2
    OR (SELECT count(*) FROM public.binders WHERE user_id IN
      ('e9000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000002') AND is_default) <> 2 THEN
    RAISE EXCEPTION 'signup/profile/default-binder triggers failed';
  END IF;
END $$;
INSERT INTO public.binders (id,user_id,name) VALUES
  ('e9100000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001','RPC source'),
  ('e9100000-0000-4000-8000-000000000002','e9000000-0000-4000-8000-000000000001','RPC target'),
  ('e9100000-0000-4000-8000-000000000003','e9000000-0000-4000-8000-000000000002','RPC foreign');
INSERT INTO public.card_index (scryfall_id,name,set_code,collector_number) VALUES
  ('e9200000-0000-4000-8000-000000000001','RPC test card','tst','rpc');
INSERT INTO public.library_cards (id,user_id,binder_id,scryfall_id,quantity) VALUES
  ('e9300000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001',
   'e9100000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001',4);

-- Every repaired writer must reject both anonymous and different-user callers
-- with insufficient_privilege, not its own input-validation/body exception.
DO $$
DECLARE caller text; expr text; denied boolean;
BEGIN
  FOREACH caller IN ARRAY ARRAY['anon','authenticated'] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('role',caller,
      'sub','e9000000-0000-4000-8000-000000000002')::text,true);
    FOREACH expr IN ARRAY ARRAY[
      $call$public.import_library_cards('e9000000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000001','[]'::jsonb)$call$,
      $call$public.move_library_cards('e9000000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000002',ARRAY['e9300000-0000-4000-8000-000000000001'::uuid])$call$,
      $call$public.promote_card_photo('e9000000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001','test.jpg')$call$,
      $call$public.delete_card_photo_and_invalidate_export('e9000000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001')$call$,
      $call$public.update_library_card_and_invalidate_export('e9000000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001','{}'::jsonb)$call$,
      $call$public.save_fb_export_snapshot('e9000000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001',2.5,1,2.5,'e9400000-0000-4000-8000-000000000001','test.jpg','NM','normal')$call$
    ] LOOP
      denied := false;
      EXECUTE format('SET LOCAL ROLE %I',caller);
      BEGIN
        EXECUTE 'SELECT ' || expr;
      EXCEPTION WHEN insufficient_privilege THEN denied := true;
      END;
      RESET ROLE;
      IF NOT denied THEN RAISE EXCEPTION 'hostile % call succeeded: %',caller,expr; END IF;
    END LOOP;
  END LOOP;
END $$;

SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $$
DECLARE target uuid; denied boolean; result record; path text :=
  'e9000000-0000-4000-8000-000000000001/e9300000-0000-4000-8000-000000000001/e9400000-0000-4000-8000-000000000001.jpg';
BEGIN
  -- Amendment2: service callers also cannot target a foreign or missing binder,
  -- even with no cards. A denied call cannot move/delete the original card.
  FOREACH target IN ARRAY ARRAY['e9100000-0000-4000-8000-000000000003'::uuid,
                               'e9100000-0000-4000-8000-000000000099'::uuid] LOOP
    denied := false;
    BEGIN
      PERFORM public.move_library_cards('e9000000-0000-4000-8000-000000000001',target,
        ARRAY['e9300000-0000-4000-8000-000000000001'::uuid]);
    EXCEPTION WHEN insufficient_privilege THEN denied := true;
    END;
    IF NOT denied THEN RAISE EXCEPTION 'destination ownership guard missing'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.library_cards WHERE id='e9300000-0000-4000-8000-000000000001'
      AND binder_id='e9100000-0000-4000-8000-000000000001' AND quantity=4) THEN
      RAISE EXCEPTION 'denied move changed source';
    END IF;
  END LOOP;
  -- All six service writer paths remain operational, without touching Storage.
  SELECT * INTO result FROM public.import_library_cards('e9000000-0000-4000-8000-000000000001',
    'e9100000-0000-4000-8000-000000000001',
    '[{"scryfall_id":"e9200000-0000-4000-8000-000000000001","quantity":1}]'::jsonb);
  IF result.merged<>1 THEN RAISE EXCEPTION 'service import did not merge'; END IF;
  PERFORM public.promote_card_photo('e9000000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001',path);
  PERFORM public.save_fb_export_snapshot('e9000000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001',
    2.5,1,2.5,'e9400000-0000-4000-8000-000000000001',path,'NM','normal');
  IF NOT EXISTS (SELECT 1 FROM public.fb_export_snapshots WHERE library_card_id='e9300000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'snapshot save failed';
  END IF;
  -- Direct table mutation specifically proves the export-invalidation trigger.
  UPDATE public.library_cards SET condition='LP' WHERE id='e9300000-0000-4000-8000-000000000001';
  IF EXISTS (SELECT 1 FROM public.fb_export_snapshots WHERE library_card_id='e9300000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'export invalidation trigger failed';
  END IF;
  PERFORM public.update_library_card_and_invalidate_export('e9000000-0000-4000-8000-000000000001',
    'e9300000-0000-4000-8000-000000000001','{"condition":"NM"}'::jsonb);
  IF public.delete_card_photo_and_invalidate_export('e9000000-0000-4000-8000-000000000001',
    'e9300000-0000-4000-8000-000000000001') IS DISTINCT FROM path THEN
    RAISE EXCEPTION 'photo delete failed';
  END IF;
  IF public.move_library_cards('e9000000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000002',
    ARRAY['e9300000-0000-4000-8000-000000000001'::uuid])<>1 THEN RAISE EXCEPTION 'same-owner move failed'; END IF;
  SELECT * INTO result FROM public.import_library_cards('e9000000-0000-4000-8000-000000000001',
    'e9100000-0000-4000-8000-000000000001',
    '[{"scryfall_id":"e9200000-0000-4000-8000-000000000001","quantity":2}]'::jsonb);
  -- Same-owner binder merge into an existing matching printing sums quantities.
  IF public.move_library_cards('e9000000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000002',
    ARRAY(SELECT id FROM public.library_cards WHERE binder_id='e9100000-0000-4000-8000-000000000001'))<>1 THEN
    RAISE EXCEPTION 'same-owner merge move failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.library_cards WHERE binder_id='e9100000-0000-4000-8000-000000000002' AND quantity=7) THEN
    RAISE EXCEPTION 'same-owner merge failed';
  END IF;
END $$;
RESET ROLE;

-- Trigger runtime regression: merchant gate, reservation synchronization,
-- inventory guard, claim-sale status hook (passive by contract).
DO $$
DECLARE card uuid; denied boolean := false;
BEGIN
  SELECT id INTO STRICT card FROM public.library_cards WHERE binder_id='e9100000-0000-4000-8000-000000000002';
  BEGIN
    INSERT INTO public.listings(user_id,library_card_id,multiplier,quantity,expires_at)
    VALUES('e9000000-0000-4000-8000-000000000001',card,2.5,3,now()+interval '1 day');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'Complete merchant payment profiling before listing' THEN RAISE; END IF;
    denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'merchant-profile trigger did not fire'; END IF;
  UPDATE public.profiles SET merchant_profile_completed_at=now(),merchant_bank_name='Test Bank',
    merchant_account_name='Test Owner',merchant_account_number='00000000'
    WHERE id='e9000000-0000-4000-8000-000000000001';
  INSERT INTO public.listings(id,user_id,library_card_id,multiplier,quantity,expires_at)
    VALUES('e9500000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001',card,2.5,3,now()+interval '1 day');
  IF NOT EXISTS (SELECT 1 FROM public.marketplace_card_reservations WHERE source_id='e9500000-0000-4000-8000-000000000001' AND reserved_quantity=3) THEN
    RAISE EXCEPTION 'listing reservation trigger failed';
  END IF;
  denied := false;
  BEGIN UPDATE public.library_cards SET quantity=2 WHERE id=card;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'RESERVATION_DRIFT' THEN RAISE; END IF;
    denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'inventory guard trigger did not fire'; END IF;
END $$;
INSERT INTO public.claim_sales(id,user_id,title,duration_hours,expires_at,delivery_option)
VALUES('e9600000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001','RPC claim test',24,now()+interval '1 day','pickup');
UPDATE public.claim_sales SET status='expired' WHERE id='e9600000-0000-4000-8000-000000000001';

ROLLBACK;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN ('e9000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000002'))
    OR EXISTS (SELECT 1 FROM public.card_index WHERE scryfall_id='e9200000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'RPC test fixture rollback failed';
  END IF;
END $$;
SELECT 'RPC_EXECUTE_PRIVILEGES_PASS' AS result;
