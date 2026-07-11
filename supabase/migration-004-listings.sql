-- Phase 8: Listings table — bazaar marketplace
-- Apply in Supabase SQL Editor (project mnyhpwqskzadkplnhbrx)

-- One listing per library card (UNIQUE constraint).
-- Cascade delete: removing a library_cards row auto-removes its listing (no orphan).
create table public.listings (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  library_card_id  uuid        not null references public.library_cards(id) on delete cascade,
  multiplier       numeric     not null check (multiplier in (2.5, 2.8, 3.0)),
  status           text        not null default 'active',
  created_at       timestamptz not null default now(),
  unique (library_card_id)
);

create index idx_listings_status_created on public.listings(status, created_at desc);
create index idx_listings_user           on public.listings(user_id);

alter table public.listings enable row level security;

-- Owners can do full CRUD on their own listings
create policy "owners manage own listings" on public.listings
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Any authenticated user can view active listings (bazaar browsing)
create policy "authenticated can view active listings" on public.listings
  for select
  using (status = 'active' and auth.role() = 'authenticated');
