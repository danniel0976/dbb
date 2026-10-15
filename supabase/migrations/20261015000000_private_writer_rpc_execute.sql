-- SECURITY HOTFIX. Production order: deploy the bulk-route service-client
-- change first, then apply this forward migration after Dan's green light.
-- No data rewrite; baseline history is immutable. Reapplication is safe.
BEGIN;

CREATE OR REPLACE FUNCTION public.move_library_cards(p_user_id uuid, p_target_binder_id uuid, p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_moved int := 0; r record;
begin
  if not exists (
    select 1 from public.binders
    where id = p_target_binder_id and user_id = p_user_id
  ) then
    raise exception 'move_library_cards: target binder does not exist or does not belong to user.'
      using errcode = '42501';
  end if;
  for r in select * from library_cards where id = any(p_ids) and user_id = p_user_id loop
    insert into library_cards (user_id, binder_id, scryfall_id, quantity, foil, condition, language, starred, purchase_price, purchase_currency, date_added)
    values (r.user_id, p_target_binder_id, r.scryfall_id, r.quantity, r.foil, r.condition, r.language, r.starred, r.purchase_price, r.purchase_currency, r.date_added)
    on conflict (user_id, binder_id, scryfall_id, foil, condition, language)
    do update set quantity = library_cards.quantity + excluded.quantity;
    delete from library_cards where id = r.id;
    v_moved := v_moved + 1;
  end loop;
  return v_moved;
end $function$;

REVOKE ALL ON FUNCTION public.delete_card_photo_and_invalidate_export(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_card_photo_and_invalidate_export(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.import_library_cards(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_library_cards(uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.move_library_cards(uuid,uuid,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_library_cards(uuid,uuid,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.promote_card_photo(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_card_photo(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.save_fb_export_snapshot(uuid,uuid,numeric,numeric,numeric,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_fb_export_snapshot(uuid,uuid,numeric,numeric,numeric,uuid,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.update_library_card_and_invalidate_export(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_library_card_and_invalidate_export(uuid,uuid,jsonb) TO service_role;

-- Trigger invocation is preserved; only direct client execution is removed.
REVOKE ALL ON FUNCTION public.enforce_listing_merchant_profile() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_profile() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_claim_sale_status_sync() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_guard_card_inventory() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase45c_sync_listing_reservation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_reserved_listing() FROM PUBLIC, anon, authenticated;

COMMIT;
