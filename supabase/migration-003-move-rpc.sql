create or replace function public.move_library_cards(
  p_user_id uuid, p_target_binder_id uuid, p_ids uuid[]
) returns int language plpgsql security definer set search_path = public as $$
declare v_moved int := 0; r record;
begin
  for r in select * from library_cards where id = any(p_ids) and user_id = p_user_id loop
    insert into library_cards (user_id, binder_id, scryfall_id, quantity, foil, condition, language, starred, purchase_price, purchase_currency, date_added)
    values (r.user_id, p_target_binder_id, r.scryfall_id, r.quantity, r.foil, r.condition, r.language, r.starred, r.purchase_price, r.purchase_currency, r.date_added)
    on conflict (user_id, binder_id, scryfall_id, foil, condition, language)
    do update set quantity = library_cards.quantity + excluded.quantity;
    delete from library_cards where id = r.id;
    v_moved := v_moved + 1;
  end loop;
  return v_moved;
end $$;
revoke execute on function public.move_library_cards from anon, authenticated;
grant execute on function public.move_library_cards to service_role;
