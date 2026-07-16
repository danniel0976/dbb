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

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.promote_card_photo(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not execute promote_card_photo';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.promote_card_photo(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must execute promote_card_photo';
  END IF;
END
$$;

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
    IF SQLERRM = 'internal service-role guard did not fire' OR SQLERRM NOT LIKE '%service role required%' THEN
      RAISE;
    END IF;
  END;
END
$$;

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
  IF v_previous IS NOT NULL THEN RAISE EXCEPTION 'first promotion returned a previous path'; END IF;

  BEGIN
    PERFORM public.promote_card_photo(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      'bad/path.jpg'
    );
    RAISE EXCEPTION 'invalid path was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'invalid path was accepted' OR SQLERRM NOT LIKE '%invalid photo candidate path%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.promote_card_photo(
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/66666666-6666-4666-8666-666666666666.jpg'
    );
    RAISE EXCEPTION 'wrong owner was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'wrong owner was accepted' OR SQLERRM NOT LIKE '%library card not found%' THEN RAISE; END IF;
  END;
END
$$;

SELECT public.save_fb_export_snapshot(
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  3.0, 10.00, 30.00,
  '77777777-7777-4777-8777-777777777777',
  '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg',
  'NM', 'normal'
);

DO $$
BEGIN
  BEGIN
    PERFORM public.save_fb_export_snapshot(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      3.0, 10.00, 30.00,
      '88888888-8888-4888-8888-888888888888',
      '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555.jpg',
      'LP', 'normal'
    );
    RAISE EXCEPTION 'stale card details were accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'stale card details were accepted' OR SQLERRM NOT LIKE '%card details changed during generation%' THEN RAISE; END IF;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.fb_export_snapshots
      (user_id, library_card_id, multiplier, ckd_usd_snapshot, myr_price_snapshot, generation_id, photo_storage_path)
    VALUES
      (
        '11111111-1111-4111-8111-111111111111',
        '44444444-4444-4444-8444-444444444444',
        3.0, 10.00, 30.00,
        '88888888-8888-4888-8888-888888888888',
        '11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444/99999999-9999-4999-8999-999999999999.jpg'
      );
    RAISE EXCEPTION 'cross-owner snapshot was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$$;

DO $$
DECLARE
  v_previous text;
BEGIN
  v_previous := public.promote_card_photo(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg'
  );
  IF v_previous NOT LIKE '%55555555-5555-4555-8555-555555555555.jpg' THEN
    RAISE EXCEPTION 'replacement did not return previous canonical path';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fb_export_snapshots WHERE library_card_id = '33333333-3333-4333-8333-333333333333') THEN
    RAISE EXCEPTION 'promotion did not invalidate snapshot';
  END IF;
END
$$;

INSERT INTO public.fb_export_snapshots
  (user_id, library_card_id, multiplier, ckd_usd_snapshot, myr_price_snapshot, generation_id, photo_storage_path)
VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    2.8, 12.00, 33.60,
    'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg'
  );

SELECT public.update_library_card_and_invalidate_export(
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  '{"condition":"LP"}'
);

DO $$
BEGIN
  IF (SELECT condition FROM public.library_cards WHERE id = '33333333-3333-4333-8333-333333333333') <> 'LP' THEN
    RAISE EXCEPTION 'condition update did not persist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fb_export_snapshots WHERE library_card_id = '33333333-3333-4333-8333-333333333333') THEN
    RAISE EXCEPTION 'condition update did not invalidate snapshot';
  END IF;

  BEGIN
    PERFORM public.update_library_card_and_invalidate_export(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '{"language":"fr"}'
    );
    RAISE EXCEPTION 'unsupported update was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'unsupported update was accepted' OR SQLERRM NOT LIKE '%unsupported library card update%' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO public.fb_export_snapshots
  (user_id, library_card_id, multiplier, ckd_usd_snapshot, myr_price_snapshot, generation_id, photo_storage_path)
VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    2.5, 12.00, 30.00,
    'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg'
  );

DO $$
DECLARE
  v_deleted text;
BEGIN
  v_deleted := public.delete_card_photo_and_invalidate_export(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333'
  );
  IF v_deleted NOT LIKE '%aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg' THEN
    RAISE EXCEPTION 'photo deletion returned wrong canonical path';
  END IF;
  IF EXISTS (SELECT 1 FROM public.card_photos WHERE library_card_id = '33333333-3333-4333-8333-333333333333') THEN
    RAISE EXCEPTION 'canonical photo row was not deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fb_export_snapshots WHERE library_card_id = '33333333-3333-4333-8333-333333333333') THEN
    RAISE EXCEPTION 'photo deletion did not invalidate snapshot';
  END IF;
END
$$;

ROLLBACK;

\echo 'Phase 40 database integration checks passed'
