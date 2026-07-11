-- migration-006-cart.sql
-- Dan applies in Supabase SQL Editor (project mnyhpwqskzadkplnhbrx)

create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, listing_id)
);

create index idx_cart_items_user on public.cart_items(user_id);

alter table public.cart_items enable row level security;

-- Owner-only: users can only see/insert/update/delete their own cart items
create policy "cart owner" on public.cart_items for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
