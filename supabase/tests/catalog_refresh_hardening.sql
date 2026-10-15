-- Focused catalog publication hardening checks. Disposable local Supabase only.
BEGIN;

DO $$
DECLARE
  v_signature regprocedure;
  v_public_execute boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege
    WHERE n.nspname = 'public'
      AND p.proname = 'publish_catalog_refresh'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) INTO v_public_execute;

  IF v_public_execute THEN
    RAISE EXCEPTION 'catalog hardening: PUBLIC can execute publish_catalog_refresh';
  END IF;

  v_signature := to_regprocedure('public.publish_catalog_refresh(uuid,text,text,integer,integer)');
  IF v_signature IS NULL THEN
    RAISE EXCEPTION 'catalog hardening: completeness-aware publish signature is missing';
  END IF;

  IF has_function_privilege('anon', v_signature, 'EXECUTE')
    OR has_function_privilege('authenticated', v_signature, 'EXECUTE')
    OR NOT has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'catalog hardening: publish privilege boundary is wrong';
  END IF;
END $$;

DO $$
DECLARE
  v_refresh uuid := 'd5000000-0000-4000-8000-000000000101';
BEGIN
  INSERT INTO public.catalog_refresh_staging (
    refresh_id, scryfall_id, name, set_code, set_name, collector_number,
    rarity, colors, type_line, cmc, mana_cost, image_uris, finishes
  ) VALUES (
    v_refresh, 'd5000000-0000-4000-8000-000000000102', 'Truncated Catalog Card',
    'uatx', 'UAT Set', '1', 'rare', ARRAY['R'], 'Creature', 1, '{R}', NULL, ARRAY['nonfoil']
  );

  BEGIN
    PERFORM public.publish_catalog_refresh(v_refresh, 'test', 'test-hash', 1, 0);
    RAISE EXCEPTION 'catalog hardening: truncated refresh unexpectedly published';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%at least 100000 accepted rows%' THEN
      RAISE;
    END IF;
  END;
END $$;

ROLLBACK;
SELECT 'CATALOG_REFRESH_HARDENING_PASS' AS result;
