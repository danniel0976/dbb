-- ============================================================
-- DBB Multi-User Library — Phase 1 Schema Migration
-- Project: mnyhpwqskzadkplnhbrx
-- Run this in the Supabase SQL Editor (dashboard → SQL Editor)
-- for project https://supabase.com/dashboard/project/mnyhpwqskzadkplnhbrx
-- ============================================================

-- ===== profiles (1:1 with auth.users) =====
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text,
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- auto-create profile on signup (username from raw_user_meta_data)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'username', 'user_' || left(new.id::text, 8)),
          new.raw_user_meta_data->>'display_name');
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== binders =====
create table public.binders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  description text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index one_default_binder_per_user
  on public.binders(user_id) where is_default;
create index idx_binders_user on public.binders(user_id);

-- default "General" binder on profile creation
create or replace function public.handle_new_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.binders (user_id, name, is_default) values (new.id, 'General', true);
  return new;
end $$;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.handle_new_profile();

-- ===== shared card attribute cache (search fields ONLY — no images/text) =====
create table public.card_index (
  scryfall_id uuid primary key,
  name text not null,
  set_code text not null,
  set_name text,
  collector_number text not null,
  rarity text,
  colors text[] not null default '{}',        -- color identity, W U B R G
  type_line text,
  cmc numeric(6,2),
  mana_cost text,
  updated_at timestamptz not null default now()
);
create index idx_card_index_name on public.card_index using gin (to_tsvector('simple', name));
create index idx_card_index_name_trgm on public.card_index (lower(name) text_pattern_ops);
create index idx_card_index_set on public.card_index(set_code);
create index idx_card_index_colors on public.card_index using gin(colors);

-- ===== per-user library rows (lean) =====
create table public.library_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  binder_id uuid not null references public.binders(id) on delete cascade,
  scryfall_id uuid not null references public.card_index(scryfall_id),
  quantity int not null default 1 check (quantity between 1 and 9999),
  foil text not null default 'normal' check (foil in ('normal','foil','etched')),
  condition text not null default 'NM' check (condition in ('M','NM','LP','MP','HP','DMG')),
  language text not null default 'en',
  starred boolean not null default false,
  purchase_price numeric(10,2),
  purchase_currency text,
  date_added timestamptz not null default now(),
  unique (user_id, binder_id, scryfall_id, foil, condition, language)
);
create index idx_library_user on public.library_cards(user_id);
create index idx_library_user_binder on public.library_cards(user_id, binder_id);
create index idx_library_user_starred on public.library_cards(user_id) where starred;

-- ===== idempotent bulk import (called by server with service role) =====
-- rows: [{scryfall_id, quantity, foil, condition, language, purchase_price, purchase_currency, date_added}]
create or replace function public.import_library_cards(
  p_user_id uuid, p_binder_id uuid, p_rows jsonb
) returns table (inserted int, merged int)
language plpgsql security definer set search_path = public as $$
declare v_inserted int := 0; v_merged int := 0; r jsonb;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.library_cards
      (user_id, binder_id, scryfall_id, quantity, foil, condition, language,
       purchase_price, purchase_currency, date_added)
    values
      (p_user_id, p_binder_id, (r->>'scryfall_id')::uuid,
       coalesce((r->>'quantity')::int, 1),
       coalesce(r->>'foil', 'normal'), coalesce(r->>'condition', 'NM'),
       coalesce(r->>'language', 'en'),
       nullif(r->>'purchase_price','')::numeric,
       r->>'purchase_currency',
       coalesce((r->>'date_added')::timestamptz, now()))
    on conflict (user_id, binder_id, scryfall_id, foil, condition, language)
    do update set quantity = library_cards.quantity + excluded.quantity;
    if found then
      if (select xmax = 0 from library_cards
          where user_id = p_user_id and binder_id = p_binder_id
            and scryfall_id = (r->>'scryfall_id')::uuid
            and foil = coalesce(r->>'foil','normal')
            and condition = coalesce(r->>'condition','NM')
            and language = coalesce(r->>'language','en')) then
        v_inserted := v_inserted + 1;
      else
        v_merged := v_merged + 1;
      end if;
    end if;
  end loop;
  return query select v_inserted, v_merged;
end $$;
revoke execute on function public.import_library_cards from anon, authenticated;

-- ===== RLS =====
alter table public.profiles enable row level security;
alter table public.binders enable row level security;
alter table public.library_cards enable row level security;
alter table public.card_index enable row level security;

create policy "own profile read"   on public.profiles for select using (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);

create policy "own binders" on public.binders for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own library" on public.library_cards for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- card_index: readable by any signed-in user; written only by service role
create policy "card_index read" on public.card_index for select
  using (auth.role() = 'authenticated');
