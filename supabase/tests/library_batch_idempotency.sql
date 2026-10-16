-- Disposable Supabase SQL/role simulation; not JWT transport or physical UAT.
BEGIN;
DO $$ BEGIN
  IF to_regprocedure('public.import_library_cards_once(uuid,uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'BATCH_ONCE_MISSING: retry-safe RPC is required';
  END IF;
END $$;
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('e8000000-0000-4000-8000-000000000001','batch-once-owner@dbb.test','{"username":"batch_once_owner"}'),
 ('e8000000-0000-4000-8000-000000000002','batch-once-other@dbb.test','{"username":"batch_once_other"}');
INSERT INTO public.binders(id,user_id,name) VALUES
 ('e8100000-0000-4000-8000-000000000001','e8000000-0000-4000-8000-000000000001','Batch once'),
 ('e8100000-0000-4000-8000-000000000002','e8000000-0000-4000-8000-000000000001','Batch alternate'),
 ('e8100000-0000-4000-8000-000000000003','e8000000-0000-4000-8000-000000000002','Batch foreign');
INSERT INTO public.card_index(scryfall_id,name,set_code,collector_number) VALUES
 ('e8200000-0000-4000-8000-000000000001','Batch once fixture','tst','batch');
DO $$
DECLARE u uuid := 'e8000000-0000-4000-8000-000000000001';
 b uuid := 'e8100000-0000-4000-8000-000000000001';
 k uuid := 'e8400000-0000-4000-8000-000000000001';
 rows jsonb := '[{"scryfall_id":"e8200000-0000-4000-8000-000000000001","quantity":3}]';
 r record; denied boolean; caller text; v_signature regprocedure;
BEGIN
 v_signature := 'public.import_library_cards_once(uuid,uuid,uuid,jsonb)'::regprocedure;
 IF has_function_privilege('anon',v_signature,'EXECUTE') OR has_function_privilege('authenticated',v_signature,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_signature,'EXECUTE') OR EXISTS (
   SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=v_signature AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
  RAISE EXCEPTION 'batch RPC effective privileges incorrect'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.library_batch_receipts'::regclass)
  OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.library_batch_receipts'::regclass)
  OR has_table_privilege('anon','public.library_batch_receipts','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('authenticated','public.library_batch_receipts','SELECT,INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'receipt table boundary incorrect'; END IF;
 FOREACH caller IN ARRAY ARRAY['anon','authenticated'] LOOP
  denied := false;
  EXECUTE format('SET LOCAL ROLE %I',caller);
  BEGIN PERFORM public.import_library_cards_once(u,b,k,rows);
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  RESET ROLE;
  IF NOT denied THEN RAISE EXCEPTION 'hostile % must fail 42501',caller; END IF;
 END LOOP;
 SET LOCAL ROLE service_role;
 SELECT * INTO r FROM public.import_library_cards_once(u,b,k,rows);
 IF r.inserted<>1 OR r.merged<>0 OR r.replayed THEN RAISE EXCEPTION 'first insert counts wrong'; END IF;
 IF (SELECT quantity FROM public.library_cards WHERE user_id=u AND binder_id=b)<>3 THEN RAISE EXCEPTION 'first write missing'; END IF;
 SELECT * INTO r FROM public.import_library_cards_once(u,b,k,rows);
 IF r.inserted<>1 OR r.merged<>0 OR NOT r.replayed THEN RAISE EXCEPTION 'stored insert counts not replayed'; END IF;
 denied := false;
 BEGIN PERFORM public.import_library_cards_once(u,b,k,
  '[{"scryfall_id":"e8200000-0000-4000-8000-000000000001","quantity":99}]');
 EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM <> 'BATCH_ID_REUSED' THEN RAISE; END IF; denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'same batch id accepted different rows'; END IF;
 IF (SELECT quantity FROM public.library_cards WHERE user_id=u AND binder_id=b)<>3 THEN RAISE EXCEPTION 'replay changed inventory'; END IF;
 SELECT * INTO r FROM public.import_library_cards_once(u,b,'e8400000-0000-4000-8000-000000000002',rows);
 IF r.inserted<>0 OR r.merged<>1 OR r.replayed THEN RAISE EXCEPTION 'new key merge counts wrong'; END IF;
 SELECT * INTO r FROM public.import_library_cards_once(u,b,'e8400000-0000-4000-8000-000000000002',rows);
 IF r.inserted<>0 OR r.merged<>1 OR NOT r.replayed THEN RAISE EXCEPTION 'stored merge counts not replayed'; END IF;
 IF (SELECT quantity FROM public.library_cards WHERE user_id=u AND binder_id=b)<>6 THEN RAISE EXCEPTION 'merge replay added quantity'; END IF;
 -- The same id belongs to a different user, not a global receipt namespace.
 SELECT * INTO r FROM public.import_library_cards_once('e8000000-0000-4000-8000-000000000002',
  'e8100000-0000-4000-8000-000000000003',k,rows);
 IF r.inserted<>1 OR r.replayed THEN RAISE EXCEPTION 'user-scoped key failed'; END IF;
 denied := false;
 BEGIN PERFORM public.import_library_cards_once(u,'e8100000-0000-4000-8000-000000000003',k,rows);
 EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'foreign binder accepted'; END IF;
 denied := false;
 BEGIN PERFORM public.import_library_cards_once(u,'e8100000-0000-4000-8000-000000000002',k,rows);
 EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM <> 'BATCH_ID_REUSED' THEN RAISE; END IF; denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'reused key retargeted binder'; END IF;
 -- A failure after a valid first row rolls back both that row and the receipt.
 denied := false;
 BEGIN PERFORM public.import_library_cards_once(u,b,'e8400000-0000-4000-8000-000000000003',
  '[{"scryfall_id":"e8200000-0000-4000-8000-000000000001","quantity":1},{"scryfall_id":"e8200000-0000-4000-8000-000000000099","quantity":1}]');
 EXCEPTION WHEN foreign_key_violation THEN denied := true; END;
 IF NOT denied OR EXISTS (SELECT 1 FROM public.library_batch_receipts WHERE user_id=u AND batch_id='e8400000-0000-4000-8000-000000000003') THEN
  RAISE EXCEPTION 'failed batch left a receipt'; END IF;
 IF (SELECT quantity FROM public.library_cards WHERE user_id=u AND binder_id=b)<>6 THEN RAISE EXCEPTION 'failed batch left a partial write'; END IF;
 RESET ROLE;
END $$;
ROLLBACK;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM auth.users WHERE email IN ('batch-once-owner@dbb.test','batch-once-other@dbb.test'))
  OR EXISTS (SELECT 1 FROM public.card_index WHERE scryfall_id='e8200000-0000-4000-8000-000000000001')
  OR EXISTS (SELECT 1 FROM public.library_batch_receipts WHERE user_id IN ('e8000000-0000-4000-8000-000000000001','e8000000-0000-4000-8000-000000000002')) THEN
  RAISE EXCEPTION 'batch fixture rollback failed'; END IF;
END $$;
SELECT 'LIBRARY_BATCH_IDEMPOTENCY_SQL_PASS: 10 behavior/security cases and rollback' AS result;
