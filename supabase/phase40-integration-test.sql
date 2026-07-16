\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'phase40-owner@example.test', '{"username":"phase40_owner"}'),
  ('22222222-2222-4222-8222-222222222222', 'phase40-other@example.test', '{"username":"phase40_other"}');

INSERT INTO public.card_index (scryfall_id, name, set_code, collector_number)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Phase 40 Owner Card', 'TST', '1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Phase 40 Other Card', 'TST', '2');

INSERT INTO public.library_cards (id, user_id, binder_id, scryfall_id)
VALUES
  (
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    (SELECT id FROM public.binders WHERE user_id = '11111111-1111-4111-8111-111111111111'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    '22222222-2222-4222-8222-222222222222',
    (SELECT id FROM public.binders WHERE user_id = '22222222-2222-4222-8222-222222222222'),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );

-- Privileges and policies must express owner-read/service-write before the
-- behavioural checks below exercise those boundaries with real SQL roles.
DO $$
DECLARE
  v_function regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.promote_card_photo(uuid,uuid,text)'::regprocedure,
    'public.update_library_card_and_invalidate_export(uuid,uuid,jsonb)'::regprocedure,
    'public.delete_card_photo_and_invalidate_export(uuid,uuid)'::regprocedure,
    'public.save_fb_export_snapshot(uuid,uuid,numeric,numeric,numeric,uuid,text,text,text)'::regprocedure
  ] LOOP
    IF has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated must not execute service function %', v_function;
    END IF;
    IF NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role must execute service function %', v_function;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('authenticated', 'public.card_photos', 'SELECT')
     OR has_table_privilege('authenticated', 'public.card_photos', 'INSERT')
     OR has_table_privilege('authenticated', 'public.card_photos', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.card_photos', 'DELETE')
     OR has_table_privilege('authenticated', 'public.card_photos', 'TRUNCATE') THEN
    RAISE EXCEPTION 'card_photos privileges are not owner-read/service-write';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.fb_export_snapshots', 'SELECT')
     OR has_table_privilege('authenticated', 'public.fb_export_snapshots', 'INSERT')
     OR has_table_privilege('authenticated', 'public.fb_export_snapshots', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.fb_export_snapshots', 'DELETE')
     OR has_table_privilege('authenticated', 'public.fb_export_snapshots', 'TRUNCATE') THEN
    RAISE EXCEPTION 'fb_export_snapshots privileges are not owner-read/service-write';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname IN ('owner update card photos', 'owner delete card photos')
  ) THEN
    RAISE EXCEPTION 'authenticated storage overwrite/delete policy still exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'owner upload card photos'
      AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'signed-upload INSERT policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.card_photos'::regclass
      AND conname = 'card_photos_versioned_storage_path_check'
      AND contype = 'c'
      AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'versioned path compatibility constraint is missing or unexpectedly validated';
  END IF;
END
$$;

-- An authenticated SQL role cannot call the service RPC even with a matching
-- owner claim. This tests the database grant, not only the function's guard.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}', true);

DO $$
BEGIN
  BEGIN
    PERFORM public.promote_card_photo(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg'
    );
    RAISE EXCEPTION 'authenticated executed promote_card_photo';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

RESET ROLE;

-- The SECURITY DEFINER guard independently rejects a forged authenticated JWT
-- if a privileged SQL role invokes the function internally.
SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}', true);

DO $$
BEGIN
  BEGIN
    PERFORM public.promote_card_photo(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg'
    );
    RAISE EXCEPTION 'internal service-role guard did not fire';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'internal service-role guard did not fire'
       OR SQLERRM NOT LIKE '%service role required%' THEN
      RAISE;
    END IF;
  END;
END
$$;

-- Seed canonical photos and snapshots through the authoritative RPCs while
-- running as the real service_role SQL role.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role","sub":"11111111-1111-4111-8111-111111111111"}', true);

DO $$
DECLARE
  v_previous text;
BEGIN
  v_previous := public.promote_card_photo(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg'
  );
  IF v_previous IS NOT NULL THEN
    RAISE EXCEPTION 'first owner promotion returned a previous path';
  END IF;

  v_previous := public.promote_card_photo(
    '22222222-2222-4222-8222-222222222222',
    '44444444-4444-4444-8444-444444444444',
    '22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444/66666666-6666-4666-8666-666666666666.jpg'
  );
  IF v_previous IS NOT NULL THEN
    RAISE EXCEPTION 'first other-user promotion returned a previous path';
  END IF;

  BEGIN
    PERFORM public.promote_card_photo(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      'bad/path.jpg'
    );
    RAISE EXCEPTION 'invalid path was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'invalid path was accepted'
       OR SQLERRM NOT LIKE '%invalid photo candidate path%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.promote_card_photo(
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/77777777-7777-4777-8777-777777777777.jpg'
    );
    RAISE EXCEPTION 'wrong owner was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'wrong owner was accepted'
       OR SQLERRM NOT LIKE '%library card not found%' THEN
      RAISE;
    END IF;
  END;
END
$$;

SELECT public.save_fb_export_snapshot(
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  3.0, 10.00, 30.00,
  '88888888-8888-4888-8888-888888888888',
  '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg',
  'NM', 'normal'
);

SELECT public.save_fb_export_snapshot(
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444444',
  2.0, 8.00, 16.00,
  '99999999-9999-4999-8999-999999999999',
  '22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444/66666666-6666-4666-8666-666666666666.jpg',
  'NM', 'normal'
);

DO $$
BEGIN
  BEGIN
    PERFORM public.save_fb_export_snapshot(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      3.0, 10.00, 30.00,
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg',
      'LP', 'normal'
    );
    RAISE EXCEPTION 'stale card details were accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'stale card details were accepted'
       OR SQLERRM NOT LIKE '%card details changed during generation%' THEN
      RAISE;
    END IF;
  END;
END
$$;

RESET ROLE;

-- Owners can read only their own canonical metadata and snapshot. Every direct
-- mutation attempt is denied at the table privilege boundary.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.card_photos) <> 1
     OR EXISTS (
       SELECT 1 FROM public.card_photos
       WHERE user_id = '22222222-2222-4222-8222-222222222222'
     ) THEN
    RAISE EXCEPTION 'card_photos owner-only read failed';
  END IF;

  IF (SELECT count(*) FROM public.fb_export_snapshots) <> 1
     OR EXISTS (
       SELECT 1 FROM public.fb_export_snapshots
       WHERE user_id = '22222222-2222-4222-8222-222222222222'
     ) THEN
    RAISE EXCEPTION 'fb_export_snapshots owner-only read failed';
  END IF;

  BEGIN
    INSERT INTO public.card_photos (user_id, library_card_id, storage_path)
    VALUES (
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb.jpg'
    );
    RAISE EXCEPTION 'authenticated inserted canonical photo metadata';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.card_photos
    SET storage_path = '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.jpg';
    RAISE EXCEPTION 'authenticated updated canonical photo metadata';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM public.card_photos;
    RAISE EXCEPTION 'authenticated deleted canonical photo metadata';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.fb_export_snapshots
      (user_id, library_card_id, multiplier, ckd_usd_snapshot,
       myr_price_snapshot, generation_id, photo_storage_path)
    VALUES (
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      9.0, 9.00, 81.00,
      'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg'
    );
    RAISE EXCEPTION 'authenticated inserted export snapshot';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.fb_export_snapshots SET multiplier = 9.0;
    RAISE EXCEPTION 'authenticated updated export snapshot';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM public.fb_export_snapshots;
    RAISE EXCEPTION 'authenticated deleted export snapshot';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- Quantity, starred, and no-op condition/foil writes must preserve the snapshot.
UPDATE public.library_cards
SET quantity = quantity + 1
WHERE id = '33333333-3333-4333-8333-333333333333';

UPDATE public.library_cards
SET starred = NOT starred
WHERE id = '33333333-3333-4333-8333-333333333333';

UPDATE public.library_cards
SET condition = condition,
    foil = foil
WHERE id = '33333333-3333-4333-8333-333333333333';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.fb_export_snapshots
    WHERE library_card_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'quantity/starred/no-op direct update invalidated snapshot';
  END IF;
END
$$;

-- A persisted direct condition change must invalidate through the DB trigger.
UPDATE public.library_cards
SET condition = 'LP'
WHERE id = '33333333-3333-4333-8333-333333333333';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fb_export_snapshots
    WHERE library_card_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'direct condition update did not invalidate snapshot';
  END IF;
END
$$;

RESET ROLE;

-- Recreate the snapshot, then prove a direct authenticated foil change also
-- invalidates it.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role","sub":"11111111-1111-4111-8111-111111111111"}', true);

SELECT public.save_fb_export_snapshot(
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  2.8, 12.00, 33.60,
  'cccccccc-1111-4111-8111-cccccccccccc',
  '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg',
  'LP', 'normal'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}', true);

UPDATE public.library_cards
SET foil = 'foil'
WHERE id = '33333333-3333-4333-8333-333333333333';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fb_export_snapshots
    WHERE library_card_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'direct foil update did not invalidate snapshot';
  END IF;
END
$$;

RESET ROLE;

-- The service update RPC now delegates invalidation semantics to the same DB
-- trigger: quantity/starred/no-op card details preserve the snapshot.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role","sub":"11111111-1111-4111-8111-111111111111"}', true);

SELECT public.save_fb_export_snapshot(
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  2.5, 12.00, 30.00,
  'cccccccc-2222-4222-8222-cccccccccccc',
  '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg',
  'LP', 'foil'
);

SELECT public.update_library_card_and_invalidate_export(
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  '{"quantity":3,"starred":false,"condition":"LP","foil":"foil"}'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.fb_export_snapshots
    WHERE library_card_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'quantity/starred/no-op service update invalidated snapshot';
  END IF;

  BEGIN
    PERFORM public.update_library_card_and_invalidate_export(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '{"language":"fr"}'
    );
    RAISE EXCEPTION 'unsupported update was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'unsupported update was accepted'
       OR SQLERRM NOT LIKE '%unsupported library card update%' THEN
      RAISE;
    END IF;
  END;
END
$$;

-- Replacement and deletion RPCs remain service-only, return the previous path,
-- and atomically invalidate the snapshot metadata.
DO $$
DECLARE
  v_previous text;
BEGIN
  v_previous := public.promote_card_photo(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/dddddddd-1111-4111-8111-dddddddddddd.jpg'
  );
  IF v_previous NOT LIKE '%55555555-5555-4555-8555-555555555555.jpg' THEN
    RAISE EXCEPTION 'replacement did not return previous canonical path';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fb_export_snapshots
    WHERE library_card_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'promotion did not invalidate snapshot';
  END IF;
END
$$;

SELECT public.save_fb_export_snapshot(
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  2.5, 12.00, 30.00,
  'cccccccc-3333-4333-8333-cccccccccccc',
  '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/dddddddd-1111-4111-8111-dddddddddddd.jpg',
  'LP', 'foil'
);

DO $$
DECLARE
  v_deleted text;
BEGIN
  v_deleted := public.delete_card_photo_and_invalidate_export(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333'
  );
  IF v_deleted NOT LIKE '%dddddddd-1111-4111-8111-dddddddddddd.jpg' THEN
    RAISE EXCEPTION 'photo deletion returned wrong canonical path';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.card_photos
    WHERE library_card_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'canonical photo row was not deleted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fb_export_snapshots
    WHERE library_card_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'photo deletion did not invalidate snapshot';
  END IF;
END
$$;

RESET ROLE;
ROLLBACK;

\echo 'Phase 40 database integration checks passed'
