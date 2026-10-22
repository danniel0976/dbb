\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
 IF has_function_privilege('anon','public.publish_catalog_refresh(uuid,text,text,integer,integer)','EXECUTE')
 OR has_function_privilege('authenticated','public.publish_catalog_refresh(uuid,text,text,integer,integer)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.publish_catalog_refresh(uuid,text,text,integer,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'publisher effective ACL failed'; END IF;
END $$;
SET LOCAL ROLE anon;
DO $$ BEGIN
 PERFORM public.publish_catalog_refresh('a3000000-0000-4000-8000-000000000001','test','test',100000,0);
 RAISE EXCEPTION 'anon unexpectedly invoked publisher';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 PERFORM public.publish_catalog_refresh('a3000000-0000-4000-8000-000000000001','test','test',100000,0);
 RAISE EXCEPTION 'authenticated unexpectedly invoked publisher';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
INSERT INTO card_index(scryfall_id,name,set_code,collector_number,lang)
VALUES(md5('A3 proof 1')::uuid,'A3 Generic old','tst','1','fr');
INSERT INTO catalog_refresh_staging(refresh_id,scryfall_id,name,set_code,collector_number,lang,oracle_id,illustration_id,released_at,frame,frame_effects,promo_types,border_color,has_face_images,face_illustration_ids,promo,set_type,layout,games,image_uris)
SELECT 'a3000000-0000-4000-8000-000000000001'::uuid,md5('A3 proof '||n)::uuid,
 'A3 Generic '||n,'tst',n::text,CASE WHEN n%2=0 THEN 'ja' ELSE 'en' END,
 'a3000000-0000-4000-8000-000000000002'::uuid,'a3000000-0000-4000-8000-000000000003'::uuid,
 '2025-01-01'::date,'2015',ARRAY['showcase'],ARRAY['prerelease'],'borderless',true,
 ARRAY['a3000000-0000-4000-8000-000000000003'::uuid,'a3000000-0000-4000-8000-000000000004'::uuid],true,'expansion','transform',ARRAY['paper'],
 '{"small":"https://example.invalid/front.jpg"}'::jsonb
FROM generate_series(1,100000) n;
DO $$ BEGIN
 BEGIN
 PERFORM public.publish_catalog_refresh('a3000000-0000-4000-8000-000000000001','test','test',99999,0);
 RAISE EXCEPTION 'mismatch unexpectedly admitted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%row count mismatch%' THEN RAISE; END IF; END;
 BEGIN
 PERFORM public.publish_catalog_refresh('a3000000-0000-4000-8000-000000000001','test','test',100000,20000);
 RAISE EXCEPTION 'incomplete unexpectedly admitted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%85 percent%' THEN RAISE; END IF; END;
 IF (SELECT lang FROM card_index WHERE scryfall_id=md5('A3 proof 1')::uuid)<>'fr' THEN RAISE EXCEPTION 'rejected publish changed live data'; END IF;
END $$;
SET LOCAL ROLE service_role;
SELECT * FROM public.publish_catalog_refresh('a3000000-0000-4000-8000-000000000001','test','test',100000,1000);
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM card_index WHERE name LIKE 'A3 Generic %' AND catalog_current AND lang IN ('en','ja') AND oracle_id='a3000000-0000-4000-8000-000000000002' AND illustration_id='a3000000-0000-4000-8000-000000000003' AND released_at='2025-01-01' AND frame='2015' AND frame_effects=ARRAY['showcase'] AND promo_types=ARRAY['prerelease'] AND border_color='borderless' AND has_face_images AND array_length(face_illustration_ids,1)=2 AND promo AND set_type='expansion' AND layout='transform' AND games=ARRAY['paper'] AND image_uris->>'small'='https://example.invalid/front.jpg')<>100000 THEN RAISE EXCEPTION 'metadata insert/upsert lost fields'; END IF;
 IF EXISTS(SELECT FROM catalog_refresh_staging WHERE refresh_id='a3000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'staging cleanup failed'; END IF;
 IF (SELECT row_count FROM catalog_state WHERE id)<>100000 THEN RAISE EXCEPTION 'state not atomically published'; END IF;
END $$;
SELECT 'A3_METADATA_LOCAL_PASS' AS result,
 pg_column_size(ROW(lang,oracle_id,illustration_id,released_at,frame,frame_effects,promo_types,border_color,has_face_images,face_illustration_ids,promo,set_type,layout,games))-pg_column_size(ROW(NULL::text,NULL::uuid,NULL::uuid,NULL::date,NULL::text,NULL::text[],NULL::text[],NULL::text,NULL::boolean,NULL::uuid[],NULL::boolean,NULL::text,NULL::text,NULL::text[])) AS populated_metadata_bytes
FROM card_index WHERE scryfall_id=md5('A3 proof 1')::uuid;
ROLLBACK;
