-- DBB local-UAT baseline (legacy schema only)
--
-- This canonical squash is the first migration in the CLI-visible chain.
-- Later Phase 39, 40, 41, and 45 migrations remain separate and are applied
-- afterward in timestamp order. Legacy files remain beside this file as
-- provenance and are not read automatically by the Supabase CLI.
--
-- The obsolete foil-pricing migration is intentionally excluded: it targets
-- the retired public.cards schema and cannot execute against the current
-- public.card_index/library_cards schema.

BEGIN;

-- ============================================================================
-- SOURCE supabase/migration-002-multiuser.sql
-- ============================================================================
-- ============================================================
-- DBB Multi-User Library — Phase 1 Schema Migration
-- Project: dbb-uat
-- Run this in the Supabase SQL Editor (dashboard → SQL Editor)
-- for project LOCAL UAT ONLY
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

-- ============================================================================
-- SOURCE supabase/migration-003-move-rpc.sql
-- ============================================================================
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

-- ============================================================================
-- SOURCE supabase/migration-004-listings.sql
-- ============================================================================
-- Phase 8: Listings table — bazaar marketplace
-- Local UAT provenance; not a hosted project.

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

-- ============================================================================
-- SOURCE supabase/migration-005-indexes.sql
-- ============================================================================
-- migration-005-indexes.sql — Phase 9 performance indexes
-- (Recreated 2026-07-11: Phase 9's worker documented this file in its report
-- but never committed it. Contents per the Phase 9 completion report.)
-- Safe to run at any time — IF NOT EXISTS throughout. Apply in Supabase SQL Editor.

-- Library listing: main query path is (user, binder, newest first)
CREATE INDEX IF NOT EXISTS idx_library_cards_user_binder_added
  ON public.library_cards (user_id, binder_id, date_added DESC);

-- Binder rail ordering
CREATE INDEX IF NOT EXISTS idx_binders_user_created
  ON public.binders (user_id, created_at);

-- Advanced-search filters on the card index
CREATE INDEX IF NOT EXISTS idx_card_index_rarity
  ON public.card_index (rarity);

CREATE INDEX IF NOT EXISTS idx_card_index_set_code
  ON public.card_index (set_code);

-- ============================================================================
-- SOURCE supabase/migration-006-cart.sql
-- ============================================================================
-- migration-006-cart.sql — Phase 11 cart table
-- (Recreated 2026-07-11: Phase 11's worker shipped the cart API/UI but never
-- committed this migration file. Schema per the Phase 11 spec + cart route code.)
-- Apply in Supabase SQL Editor. The cart UI/API is already deployed and
-- degrades gracefully until this runs.

CREATE TABLE IF NOT EXISTS public.cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_user ON public.cart_items (user_id);

ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;

-- Owners manage only their own cart rows.
DROP POLICY IF EXISTS cart_items_select_own ON public.cart_items;
CREATE POLICY cart_items_select_own ON public.cart_items
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS cart_items_insert_own ON public.cart_items;
CREATE POLICY cart_items_insert_own ON public.cart_items
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS cart_items_delete_own ON public.cart_items;
CREATE POLICY cart_items_delete_own ON public.cart_items
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- SOURCE supabase/migration-007-catalog.sql
-- ============================================================================
-- Migration 007: extend card_index with image_uris + finishes for full catalog support
-- Local UAT provenance; not a hosted project.

-- Enable pg_trgm for fast partial name search over large catalog
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add image URIs (small + normal) stored as {small:"...",normal:"..."}
ALTER TABLE public.card_index ADD COLUMN IF NOT EXISTS image_uris jsonb;

-- Add finishes array from Scryfall (e.g. ['nonfoil','foil'] or ['nonfoil','etched'])
ALTER TABLE public.card_index ADD COLUMN IF NOT EXISTS finishes text[] NOT NULL DEFAULT '{}';

-- GIN trigram index for fast ILIKE '%name%' over full catalog
CREATE INDEX IF NOT EXISTS idx_card_index_name_trgm_gin
  ON public.card_index USING gin(name gin_trgm_ops);

-- Index on rarity for filtered catalog search
CREATE INDEX IF NOT EXISTS idx_card_index_rarity ON public.card_index(rarity);

-- ============================================================================
-- SOURCE supabase/migration-008-indexes.sql
-- ============================================================================
-- migration-008-indexes.sql
-- Local UAT provenance; not a hosted project.
-- Safe to re-run: uses CREATE INDEX IF NOT EXISTS and CREATE OR REPLACE FUNCTION.
--
-- Purpose: Phase 13 database optimization pass.
--   1. pg_trgm GIN indexes on card_index — fixes ILIKE '%query%' catalog searches
--      (105k rows; without this, every search is a full seqscan).
--   2. Listings indexes — covers bazaar browsing (status + date sort, seller lookup).
--   3. Rewrite import_library_cards RPC — replaces a PL/pgSQL row-by-row loop with
--      a single bulk INSERT ... ON CONFLICT, order-of-magnitude faster for large imports.

-- ── 1. pg_trgm extension ──────────────────────────────────────────────────────
-- Required for gin_trgm_ops indexes. Safe to enable even if already present.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 2. GIN trigram indexes on card_index ─────────────────────────────────────
-- These make ILIKE '%query%' (used in catalog/search and advanced-search type_line
-- filters) use an index scan instead of a sequential scan over 100k+ rows.
-- Note: idx_card_index_name (full-text) and idx_card_index_name_trgm (btree
-- text_pattern_ops, prefix-only) were created in earlier migrations; the GIN
-- trigram indexes below are ADDITIVE and handle substring matches.

CREATE INDEX IF NOT EXISTS idx_card_index_name_gin_trgm
  ON public.card_index USING gin(name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_card_index_type_line_gin_trgm
  ON public.card_index USING gin(type_line gin_trgm_ops);

-- ── 3. library_cards (user_id, date_added DESC) ──────────────────────────────
-- The existing compound index (user_id, binder_id, date_added DESC) serves the
-- binder-scoped query efficiently.  For the "all cards" view (no binder filter),
-- ORDER BY date_added DESC with only a user_id predicate can't use that index's
-- sort order (binder_id is interleaved), forcing a post-scan re-sort of ~1.8k rows.
-- This two-column index eliminates the re-sort.
CREATE INDEX IF NOT EXISTS idx_library_cards_user_date
  ON public.library_cards (user_id, date_added DESC);

-- ── 4. Listings indexes ───────────────────────────────────────────────────────
-- Covers the dominant bazaar query: WHERE status = 'active' ORDER BY created_at DESC.
-- The DESC storage matches the default sort order so Postgres can avoid a re-sort.
CREATE INDEX IF NOT EXISTS idx_listings_status_created
  ON public.listings (status, created_at DESC);

-- Covers per-user listing queries (CardDetailModal "is this card listed?" check,
-- and the seller-lookup step in the bazaar route).
CREATE INDEX IF NOT EXISTS idx_listings_user_id
  ON public.listings (user_id);

-- ── 4. Bulk import_library_cards RPC ─────────────────────────────────────────
-- Replaces the original PL/pgSQL row-by-row loop (N individual INSERTs) with a
-- single INSERT ... SELECT ... ON CONFLICT that processes the entire JSON array
-- atomically.  xmax = 0 in the RETURNING clause correctly identifies fresh inserts
-- vs conflict-updates within a single INSERT statement.
--
-- Return signature is unchanged: TABLE(inserted int, merged int).
CREATE OR REPLACE FUNCTION public.import_library_cards(
  p_user_id uuid,
  p_binder_id uuid,
  p_rows jsonb
) RETURNS TABLE (inserted int, merged int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH upserted AS (
    INSERT INTO public.library_cards
      (user_id, binder_id, scryfall_id, quantity, foil, condition, language,
       purchase_price, purchase_currency, date_added)
    SELECT
      p_user_id,
      p_binder_id,
      (r.value->>'scryfall_id')::uuid,
      COALESCE((r.value->>'quantity')::int, 1),
      COALESCE(r.value->>'foil', 'normal'),
      COALESCE(r.value->>'condition', 'NM'),
      COALESCE(r.value->>'language', 'en'),
      NULLIF(r.value->>'purchase_price', '')::numeric,
      r.value->>'purchase_currency',
      COALESCE((r.value->>'date_added')::timestamptz, now())
    FROM jsonb_array_elements(p_rows) AS r(value)
    ON CONFLICT (user_id, binder_id, scryfall_id, foil, condition, language)
    DO UPDATE SET
      quantity = public.library_cards.quantity + EXCLUDED.quantity
    RETURNING (xmax = 0) AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::int   AS inserted,
    COUNT(*) FILTER (WHERE NOT is_insert)::int AS merged
  FROM upserted;
END $$;

-- Keep the same REVOKE so anon/authenticated cannot call this directly —
-- only the server-side service role can invoke it.
REVOKE EXECUTE ON FUNCTION public.import_library_cards(uuid, uuid, jsonb)
  FROM anon, authenticated;

-- ============================================================================
-- SOURCE supabase/migration-009-listing-lifecycle.sql
-- ============================================================================
-- Phase 14: Listing lifecycle — expires_at column + expiry index
-- Local UAT provenance; not a hosted project.

-- Step 1: Add expires_at as nullable first so backfill can run
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Step 2: Backfill existing rows — treat all as if they had a 24h duration
UPDATE public.listings
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

-- Step 3: Enforce NOT NULL now that all rows have a value
ALTER TABLE public.listings
  ALTER COLUMN expires_at SET NOT NULL;

-- Step 4: Composite index covering the two most common query shapes:
--   WHERE status = 'active' AND expires_at > now()   (bazaar browse, cart check)
--   WHERE status = 'active' AND expires_at < now()   (expiry sweep)
CREATE INDEX IF NOT EXISTS idx_listings_status_expires
  ON public.listings (status, expires_at);

-- ============================================================================
-- SOURCE supabase/migration-010-card-photos.sql
-- ============================================================================
-- ============================================================
-- Phase 15: Card Photos + Seller Trust
-- Apply in Supabase SQL Editor as postgres role
-- ============================================================

-- 1. card_photos table -------------------------------------------
CREATE TABLE IF NOT EXISTS public.card_photos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  library_card_id  uuid NOT NULL UNIQUE REFERENCES public.library_cards(id) ON DELETE CASCADE,
  storage_path     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_photos_user     ON public.card_photos(user_id);
CREATE INDEX IF NOT EXISTS idx_card_photos_lc       ON public.card_photos(library_card_id);

-- 2. RLS ---------------------------------------------------------
ALTER TABLE public.card_photos ENABLE ROW LEVEL SECURITY;

-- Owner can insert / update / delete their own photo rows
CREATE POLICY "owner card photos crud"
  ON public.card_photos
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Any authenticated user can select metadata (not the storage object — that requires a signed URL)
CREATE POLICY "authenticated card photos select"
  ON public.card_photos
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================================
-- STORAGE: Supabase Storage bucket + policies
-- ============================================================
-- NOTE: Storage bucket creation via SQL requires the storage extension.
-- If the INSERT below fails, create the bucket manually in the Supabase
-- Dashboard → Storage → New bucket: name="card-photos", private (unchecked Public).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'card-photos',
  'card-photos',
  false,
  5242880,                  -- 5 MB max per object
  ARRAY['image/jpeg','image/jpg','image/png','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies for objects in card-photos bucket
-- Owner can insert (upload) their own photos
CREATE POLICY "owner upload card photos"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'card-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Owner can update (overwrite) their own photos
CREATE POLICY "owner update card photos"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'card-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Owner can delete their own photos
CREATE POLICY "owner delete card photos"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'card-photos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- No direct SELECT on storage objects — all reads go through server-generated signed URLs.
-- Service role bypasses RLS and can generate signed URLs server-side.

-- ============================================================
-- DASHBOARD INSTRUCTIONS (for Dan)
-- ============================================================
-- After running this SQL:
-- 1. Go to Supabase Dashboard → Storage
--    - Verify "card-photos" bucket exists and is PRIVATE (not public)
--    - If it doesn't appear, click "New bucket":
--        Name: card-photos
--        Public bucket: OFF (unchecked)
--        File size limit: 5 MB
--        Allowed MIME types: image/jpeg, image/png, image/webp
--
-- 2. The storage object RLS policies above are applied automatically.
--    Verify them at Storage → Policies → card-photos bucket.
--
-- 3. No other dashboard actions needed — the Next.js app handles
--    uploads/signed URLs entirely server-side via the service role.
-- ============================================================

-- ============================================================================
-- SOURCE supabase/migration-011-rpc-binder-validation.sql
-- ============================================================================
-- migration-011-rpc-binder-validation.sql
-- Local UAT provenance; not a hosted project.
--
-- Purpose: Phase 17 — add binder ownership validation to import_library_cards.
--   The RPC previously accepted any binder_id without checking whether it belongs
--   to p_user_id. A caller passing the wrong user's binder would insert rows into
--   that binder unchecked (the FK only verifies the binder exists, not that the user
--   owns it). This rewrite adds an explicit ownership check and raises an informative
--   error if the binder doesn't belong to the importing user.
--
-- Backwards-compatible: signature and return type are unchanged.
-- Safe to re-run: uses CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION public.import_library_cards(
  p_user_id uuid,
  p_binder_id uuid,
  p_rows jsonb
) RETURNS TABLE (inserted int, merged int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_binder_owner uuid;
BEGIN
  -- Reject null binder — never fall back to a default
  IF p_binder_id IS NULL THEN
    RAISE EXCEPTION 'import_library_cards: p_binder_id must not be null. Every import requires an explicit binder.';
  END IF;

  -- Verify binder belongs to the importing user
  SELECT user_id INTO v_binder_owner
  FROM public.binders
  WHERE id = p_binder_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'import_library_cards: binder % does not exist.', p_binder_id;
  END IF;

  IF v_binder_owner <> p_user_id THEN
    RAISE EXCEPTION 'import_library_cards: binder % does not belong to user %.', p_binder_id, p_user_id;
  END IF;

  RETURN QUERY
  WITH upserted AS (
    INSERT INTO public.library_cards
      (user_id, binder_id, scryfall_id, quantity, foil, condition, language,
       purchase_price, purchase_currency, date_added)
    SELECT
      p_user_id,
      p_binder_id,
      (r.value->>'scryfall_id')::uuid,
      COALESCE((r.value->>'quantity')::int, 1),
      COALESCE(r.value->>'foil', 'normal'),
      COALESCE(r.value->>'condition', 'NM'),
      COALESCE(r.value->>'language', 'en'),
      NULLIF(r.value->>'purchase_price', '')::numeric,
      r.value->>'purchase_currency',
      COALESCE((r.value->>'date_added')::timestamptz, now())
    FROM jsonb_array_elements(p_rows) AS r(value)
    ON CONFLICT (user_id, binder_id, scryfall_id, foil, condition, language)
    DO UPDATE SET
      quantity = public.library_cards.quantity + EXCLUDED.quantity
    RETURNING (xmax = 0) AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::int   AS inserted,
    COUNT(*) FILTER (WHERE NOT is_insert)::int AS merged
  FROM upserted;
END $$;

-- Keep the same REVOKE — only service role can call this.
REVOKE EXECUTE ON FUNCTION public.import_library_cards(uuid, uuid, jsonb)
  FROM anon, authenticated;

-- ============================================================================
-- SOURCE supabase/migration-012-theme-preference.sql
-- ============================================================================
-- Migration 012: Add theme_preference column to profiles
-- Phase 22: Light/Dark Mode + System Default

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS theme_preference text DEFAULT 'system' CHECK (theme_preference IN ('light','dark','system'));
-- ============================================================================
-- SOURCE supabase/migration-013-claim-sales.sql
-- ============================================================================
-- Phase 24: Claim Sales
CREATE TABLE IF NOT EXISTS public.claim_sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  set_code        text,
  duration_hours  integer NOT NULL CHECK (duration_hours BETWEEN 1 AND 24),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  delivery_option text NOT NULL CHECK (delivery_option IN ('pickup','shipping','both')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claim_sales_user ON public.claim_sales(user_id);
CREATE INDEX IF NOT EXISTS idx_claim_sales_status_expires ON public.claim_sales(status, expires_at);
ALTER TABLE public.claim_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner claim_sales crud" ON public.claim_sales FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "authenticated claim_sales select" ON public.claim_sales FOR SELECT USING (auth.role() = 'authenticated');

-- Link listings to claim sales
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS claim_sale_id uuid REFERENCES public.claim_sales(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_listings_claim_sale ON public.listings(claim_sale_id) WHERE claim_sale_id IS NOT NULL;

-- Follows (claim sale follows + user follows)
CREATE TABLE IF NOT EXISTS public.follows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followee_id   uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  claim_sale_id uuid REFERENCES public.claim_sales(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (followee_id IS NOT NULL OR claim_sale_id IS NOT NULL),
  UNIQUE(follower_id, followee_id),
  UNIQUE(follower_id, claim_sale_id)
);
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner follows crud" ON public.follows FOR ALL USING (auth.uid() = follower_id) WITH CHECK (auth.uid() = follower_id);
CREATE POLICY "authenticated follows select" ON public.follows FOR SELECT USING (auth.role() = 'authenticated');
-- ============================================================================
-- SOURCE supabase/migration-014-listing-quantity.sql
-- ============================================================================
-- migration-014: Listing quantities
-- One condition photo per library_card row covers all offered copies.
-- A seller may offer 1 through their owned copy count in a singles listing or claim sale.
-- Apply in Supabase SQL Editor after migration-013.

-- Add quantity column with safe default so existing rows remain valid (1 copy).
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;

-- Ensure quantity is always a positive integer.
ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_quantity_positive;

ALTER TABLE public.listings
  ADD CONSTRAINT listings_quantity_positive CHECK (quantity > 0);

COMMENT ON COLUMN public.listings.quantity IS
  'Number of copies offered from library_cards.quantity. One card_photos row for the library_card covers all offered copies.';
-- ============================================================================
-- SOURCE supabase/migration-015-card-hashes.sql
-- ============================================================================
-- migration-015: Card image hashes for perceptual matching
-- Stores pHash (perceptual hash) values for card images so captured photos
-- can be matched against the catalog by image similarity instead of OCR.

CREATE TABLE IF NOT EXISTS public.card_hashes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scryfall_id text NOT NULL,
  phash bigint NOT NULL,
  image_uri text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(scryfall_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_card_hashes_scryfall_id ON public.card_hashes(scryfall_id);
CREATE INDEX IF NOT EXISTS idx_card_hashes_phash ON public.card_hashes(phash);

-- RLS: anyone authenticated can read (needed for match endpoint)
-- Only service role can write (hash build script uses service role)
ALTER TABLE public.card_hashes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "card_hashes_read_authenticated" ON public.card_hashes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "card_hashes_read_anon" ON public.card_hashes
  FOR SELECT TO anon USING (true);

COMMENT ON TABLE public.card_hashes IS 'Perceptual hash index for card image matching. Populated by scripts/build-card-hashes.mjs.';
COMMIT;
