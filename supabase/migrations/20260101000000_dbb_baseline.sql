-- DBB Phase 45C local-UAT baseline (squashed schema history)
--
-- This migration is a disposable local-UAT artifact. It is deliberately
-- self-contained so a clean PostgreSQL/Supabase database can be reconstructed
-- without production rows or hosted project links. The source order below is
-- the dependency order used for the squash.
--
-- This canonical baseline timestamp sorts before the existing Phase 39-45B
-- timestamped migrations, so Supabase CLI can apply the dependency chain from
-- an empty database in lexical timestamp order. Existing files are intentionally
-- untouched by this bounded worker.
--
-- Excluded deliberately: the obsolete declarative DBB schema snapshot and the
-- obsolete foil-pricing migration (its calculate_myr_prices trigger targets a
-- retired table; current DBB schema and Phase 45 code use card_index/library_cards).

-- ============================================================================
-- SOURCE 01: supabase/migration-002-multiuser.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- ============================================================
-- DBB Multi-User Library — Phase 1 Schema Migration
-- Local-UAT source provenance; no hosted project is targeted.
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
-- SOURCE 02: supabase/migration-003-move-rpc.sql
-- Included verbatim in the Phase 45C local-UAT squash.
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
-- SOURCE 03: supabase/migration-004-listings.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Phase 8: Listings table — bazaar marketplace
-- Local-UAT source provenance.

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
-- SOURCE 04: supabase/migration-005-indexes.sql
-- Included verbatim in the Phase 45C local-UAT squash.
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
-- SOURCE 05: supabase/migration-006-cart.sql
-- Included verbatim in the Phase 45C local-UAT squash.
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
-- SOURCE 06: supabase/migration-007-catalog.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Migration 007: extend card_index with image_uris + finishes for full catalog support
-- Local-UAT source provenance.

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
-- SOURCE 07: supabase/migration-008-indexes.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- migration-008-indexes.sql
-- Local-UAT source provenance.
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
-- SOURCE 08: supabase/migration-009-listing-lifecycle.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Phase 14: Listing lifecycle — expires_at column + expiry index
-- Local-UAT source provenance.

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
-- SOURCE 09: supabase/migration-010-card-photos.sql
-- Included verbatim in the Phase 45C local-UAT squash.
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
-- SOURCE 10: supabase/migration-011-rpc-binder-validation.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- migration-011-rpc-binder-validation.sql
-- Local-UAT source provenance.
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
-- SOURCE 11: supabase/migration-012-theme-preference.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Migration 012: Add theme_preference column to profiles
-- Phase 22: Light/Dark Mode + System Default

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS theme_preference text DEFAULT 'system' CHECK (theme_preference IN ('light','dark','system'));

-- ============================================================================
-- SOURCE 12: supabase/migration-013-claim-sales.sql
-- Included verbatim in the Phase 45C local-UAT squash.
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
-- SOURCE 13: supabase/migration-014-listing-quantity.sql
-- Included verbatim in the Phase 45C local-UAT squash.
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
-- SOURCE 14: supabase/migration-015-card-hashes.sql
-- Included verbatim in the Phase 45C local-UAT squash.
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

-- ============================================================================
-- SOURCE 15: supabase/migrations/20260716000000_phase39_orders.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Phase 39: manual bank-in checkout, seller-grouped orders, and store pickup.
-- DO NOT apply automatically. Production application requires Dan's approval.

-- Merchant payment details are private profile fields. They are read only through
-- server-authorized routes for the owner or the buyer during the checkout response.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS merchant_bank_name text,
  ADD COLUMN IF NOT EXISTS merchant_account_name text,
  ADD COLUMN IF NOT EXISTS merchant_account_number text,
  ADD COLUMN IF NOT EXISTS merchant_duitnow_id text,
  ADD COLUMN IF NOT EXISTS merchant_payment_instructions text,
  ADD COLUMN IF NOT EXISTS merchant_bank_qr_path text,
  ADD COLUMN IF NOT EXISTS merchant_tng_qr_path text,
  ADD COLUMN IF NOT EXISTS merchant_profile_completed_at timestamptz;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS merchant_bank_qr_owned_path,
  DROP CONSTRAINT IF EXISTS merchant_tng_qr_owned_path,
  ADD CONSTRAINT merchant_bank_qr_owned_path CHECK (
    merchant_bank_qr_path IS NULL OR merchant_bank_qr_path = id::text || '/bank_qr.jpg'
  ),
  ADD CONSTRAINT merchant_tng_qr_owned_path CHECK (
    merchant_tng_qr_path IS NULL OR merchant_tng_qr_path = id::text || '/tng_qr.jpg'
  );

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'merchant-payment-qr',
  'merchant-payment-qr',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

CREATE TABLE IF NOT EXISTS public.pickup_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  address text NOT NULL,
  operating_notes text,
  active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_default_active_pickup_location
  ON public.pickup_locations (is_default)
  WHERE active AND is_default;

INSERT INTO public.pickup_locations (slug, name, address, operating_notes, active, is_default)
VALUES (
  'cards-and-hobbies-kelana-jaya',
  'Cards & Hobbies',
  'A-3-5, Parklanes Commercial Hub, Jalan SS7/26, Kelana Jaya, 47301 Petaling Jaya, Selangor, Malaysia',
  'Confirm store operating hours before drop-off or pickup.',
  true,
  true
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  address = EXCLUDED.address,
  operating_notes = EXCLUDED.operating_notes,
  active = EXCLUDED.active,
  is_default = EXCLUDED.is_default,
  updated_at = now();

-- migration-014's listings_quantity_positive (quantity > 0) blocks checkout_orders
-- below, which reserves the last unit down to zero (status flips to 'reserved')
-- while the listing row must persist for order-item snapshots and cancellation
-- restoration. Relax the floor to zero; a listing is still hidden from the bazaar
-- once quantity reaches zero because "authenticated can view active listings" is
-- scoped to status = 'active', and checkout_orders flips status to 'reserved' in
-- the same statement that brings quantity to zero.
ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_quantity_positive,
  ADD CONSTRAINT listings_quantity_non_negative CHECK (quantity >= 0);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES public.profiles(id),
  seller_id uuid NOT NULL REFERENCES public.profiles(id),
  pickup_location_id uuid NOT NULL REFERENCES public.pickup_locations(id),
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN (
    'awaiting_payment', 'preparing_order', 'payment_received',
    'dropped_off', 'order_completed', 'cancelled'
  )),
  currency text NOT NULL DEFAULT 'MYR' CHECK (currency = 'MYR'),
  total_myr numeric(12,2) NOT NULL CHECK (total_myr > 0),
  preparing_order_at timestamptz,
  payment_received_at timestamptz,
  dropped_off_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> seller_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_buyer_created ON public.orders (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_seller_created ON public.orders (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_updated ON public.orders (status, updated_at);

CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  library_card_id uuid REFERENCES public.library_cards(id) ON DELETE SET NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_myr numeric(12,2) NOT NULL CHECK (unit_myr > 0),
  line_myr numeric(12,2) NOT NULL CHECK (line_myr > 0),
  multiplier numeric NOT NULL,
  scryfall_id uuid NOT NULL,
  card_name text NOT NULL,
  set_code text,
  set_name text,
  collector_number text,
  foil text,
  condition text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_listing ON public.order_items (listing_id) WHERE listing_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.checkout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES public.profiles(id),
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  order_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (buyer_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  event_type text NOT NULL,
  from_status text,
  to_status text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_created ON public.order_events (order_id, created_at);

CREATE TABLE IF NOT EXISTS public.order_cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(id),
  resolution text CHECK (resolution IN ('accepted', 'declined'))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_cancellation_request_per_order
  ON public.order_cancellation_requests (order_id)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS public.order_no_show_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES public.profiles(id),
  reported_user_id uuid NOT NULL REFERENCES public.profiles(id),
  report_type text NOT NULL CHECK (report_type IN ('buyer_unpaid', 'seller_stale_after_payment')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  eligible_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, reporter_id, report_type)
);

ALTER TABLE public.pickup_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_cancellation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_no_show_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated read active pickup locations" ON public.pickup_locations
  FOR SELECT USING (auth.role() = 'authenticated' AND active);
CREATE POLICY "participants read orders" ON public.orders
  FOR SELECT USING (auth.uid() = buyer_id OR auth.uid() = seller_id);
CREATE POLICY "participants read order items" ON public.order_items
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_id AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
  ));
CREATE POLICY "participants read order events" ON public.order_events
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_id AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
  ));
CREATE POLICY "participants read cancellation requests" ON public.order_cancellation_requests
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_id AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
  ));
CREATE POLICY "participants read no-show reports" ON public.order_no_show_reports
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_id AND (auth.uid() = o.buyer_id OR auth.uid() = o.seller_id)
  ));

-- Merchant profiling is enforced in the database as well as the API so direct
-- authenticated inserts cannot bypass it.
CREATE OR REPLACE FUNCTION public.enforce_listing_merchant_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = NEW.user_id
      AND p.merchant_profile_completed_at IS NOT NULL
      AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
      AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
      AND (
        nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR
        nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Complete merchant payment profiling before listing' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS listings_require_merchant_profile ON public.listings;
CREATE TRIGGER listings_require_merchant_profile
  BEFORE INSERT OR UPDATE OF status ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_listing_merchant_profile();

-- Prevent sellers from mutating inventory reserved by a non-final order through
-- direct table access. Checkout mutates before the order item exists; cancellation
-- marks the order final before restoring inventory.
CREATE OR REPLACE FUNCTION public.protect_reserved_listing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role') OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.listing_id = OLD.id
      AND o.status NOT IN ('order_completed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Listing is reserved by an active order' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS listings_protect_active_orders ON public.listings;
CREATE TRIGGER listings_protect_active_orders
  BEFORE UPDATE OR DELETE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.protect_reserved_listing();

CREATE OR REPLACE FUNCTION public.checkout_orders(
  p_buyer_id uuid,
  p_idempotency_key uuid,
  p_pickup_location_id uuid,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item jsonb;
  v_listing public.listings%ROWTYPE;
  v_card public.library_cards%ROWTYPE;
  v_seller_id uuid;
  v_order_id uuid;
  v_order_ids uuid[] := '{}';
  v_total numeric(12,2);
  v_existing_status text;
  v_existing_ids uuid[];
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'Checkout must contain between 1 and 100 items' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pickup_locations WHERE id = p_pickup_location_id AND active) THEN
    RAISE EXCEPTION 'Pickup location is unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT value->>'listing_id') FROM jsonb_array_elements(p_items)) THEN
    RAISE EXCEPTION 'Duplicate listing in checkout' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.checkout_requests (buyer_id, idempotency_key)
  VALUES (p_buyer_id, p_idempotency_key)
  ON CONFLICT (buyer_id, idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT status, order_ids INTO v_existing_status, v_existing_ids
    FROM public.checkout_requests
    WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_existing_status = 'completed' THEN
      RETURN jsonb_build_object('order_ids', to_jsonb(v_existing_ids), 'idempotent_replay', true);
    END IF;
    RAISE EXCEPTION 'Checkout request is already processing' USING ERRCODE = 'P0001';
  END IF;

  -- Lock and validate every item before writing any order row.
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'listing_id'
  LOOP
    SELECT * INTO v_listing FROM public.listings
    WHERE id = (v_item->>'listing_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found: %', v_item->>'listing_id' USING ERRCODE = 'P0001'; END IF;
    IF v_listing.user_id = p_buyer_id THEN RAISE EXCEPTION 'Cannot checkout your own listing' USING ERRCODE = 'P0001'; END IF;
    IF v_listing.status <> 'active' OR v_listing.expires_at <= now() THEN RAISE EXCEPTION 'Listing is unavailable: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
    IF v_listing.quantity < 1 THEN RAISE EXCEPTION 'Insufficient listing quantity: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.cart_items
      WHERE id = (v_item->>'cart_item_id')::uuid
        AND user_id = p_buyer_id AND listing_id = v_listing.id
    ) THEN RAISE EXCEPTION 'Item is not in buyer cart: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
    IF (v_item->>'unit_myr')::numeric <= 0 THEN RAISE EXCEPTION 'Trusted price missing for listing: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = v_listing.user_id AND p.merchant_profile_completed_at IS NOT NULL
        AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
        AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
        AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)
    ) THEN RAISE EXCEPTION 'Seller payment profile is incomplete' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id FOR UPDATE;
    IF NOT FOUND OR v_card.quantity < 1 THEN RAISE EXCEPTION 'Seller inventory is unavailable: %', v_listing.id USING ERRCODE = 'P0001'; END IF;
  END LOOP;

  FOR v_seller_id IN
    SELECT DISTINCT l.user_id
    FROM jsonb_array_elements(p_items) e
    JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid
    ORDER BY l.user_id
  LOOP
    SELECT round(sum((e.value->>'unit_myr')::numeric), 2) INTO v_total
    FROM jsonb_array_elements(p_items) e
    JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid
    WHERE l.user_id = v_seller_id;

    INSERT INTO public.orders (buyer_id, seller_id, pickup_location_id, total_myr)
    VALUES (p_buyer_id, v_seller_id, p_pickup_location_id, v_total)
    RETURNING id INTO v_order_id;
    v_order_ids := array_append(v_order_ids, v_order_id);

    FOR v_item IN
      SELECT e.value
      FROM jsonb_array_elements(p_items) e
      JOIN public.listings l ON l.id = (e.value->>'listing_id')::uuid
      WHERE l.user_id = v_seller_id
    LOOP
      SELECT * INTO v_listing FROM public.listings WHERE id = (v_item->>'listing_id')::uuid;
      SELECT * INTO v_card FROM public.library_cards WHERE id = v_listing.library_card_id;

      UPDATE public.listings
      SET quantity = quantity - 1,
          status = CASE WHEN quantity - 1 = 0 THEN 'reserved' ELSE 'active' END
      WHERE id = v_listing.id;

      INSERT INTO public.order_items (
        order_id, listing_id, library_card_id, quantity, unit_myr, line_myr,
        multiplier, scryfall_id, card_name, set_code, set_name,
        collector_number, foil, condition
      ) VALUES (
        v_order_id, v_listing.id, v_listing.library_card_id, 1,
        (v_item->>'unit_myr')::numeric, (v_item->>'unit_myr')::numeric,
        v_listing.multiplier, v_card.scryfall_id, v_item->>'card_name',
        v_item->>'set_code', v_item->>'set_name', v_item->>'collector_number',
        v_card.foil, v_card.condition
      );
    END LOOP;

    INSERT INTO public.order_events (order_id, actor_id, event_type, to_status)
    VALUES (v_order_id, p_buyer_id, 'checkout_created', 'awaiting_payment');
  END LOOP;

  DELETE FROM public.cart_items ci
  WHERE ci.user_id = p_buyer_id
    AND ci.id IN (SELECT (value->>'cart_item_id')::uuid FROM jsonb_array_elements(p_items));

  UPDATE public.checkout_requests
  SET status = 'completed', order_ids = v_order_ids, completed_at = now()
  WHERE buyer_id = p_buyer_id AND idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('order_ids', to_jsonb(v_order_ids), 'idempotent_replay', false);
END $$;

CREATE OR REPLACE FUNCTION public.transition_order(
  p_order_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_from text;
  v_item public.order_items%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  v_from := v_order.status;

  IF p_action = 'preparing_order' AND p_actor_id = v_order.seller_id AND v_from = 'awaiting_payment' THEN
    UPDATE public.orders SET status = 'preparing_order', preparing_order_at = now(), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'payment_received' AND p_actor_id = v_order.seller_id AND v_from = 'preparing_order' THEN
    UPDATE public.orders SET status = 'payment_received', payment_received_at = now(), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'dropped_off' AND p_actor_id = v_order.seller_id AND v_from = 'payment_received' THEN
    UPDATE public.orders SET status = 'dropped_off', dropped_off_at = now(), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
  ELSIF p_action = 'order_completed' AND p_actor_id = v_order.buyer_id AND v_from = 'dropped_off' THEN
    UPDATE public.orders SET status = 'order_completed', completed_at = now(), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id = p_order_id LOOP
      IF v_item.library_card_id IS NOT NULL THEN
        UPDATE public.library_cards SET quantity = quantity - v_item.quantity
        WHERE id = v_item.library_card_id AND quantity > v_item.quantity;
        IF NOT FOUND THEN
          DELETE FROM public.library_cards WHERE id = v_item.library_card_id AND quantity = v_item.quantity;
        END IF;
      END IF;
    END LOOP;
  ELSIF p_action = 'cancel' AND p_actor_id = v_order.seller_id AND v_from NOT IN ('order_completed', 'cancelled') THEN
    IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 500 THEN
      RAISE EXCEPTION 'Cancellation reason must be 5 to 500 characters' USING ERRCODE = '22023';
    END IF;
    UPDATE public.orders SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_id,
      cancellation_reason = btrim(p_reason), updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id = p_order_id LOOP
      IF v_item.listing_id IS NULL THEN RAISE EXCEPTION 'Reserved listing cannot be restored' USING ERRCODE = 'P0001'; END IF;
      UPDATE public.listings SET
        quantity = quantity + v_item.quantity,
        status = CASE
          WHEN expires_at > now() AND EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = listings.user_id
              AND p.merchant_profile_completed_at IS NOT NULL
              AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
              AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
              AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)
          ) THEN 'active'
          ELSE 'expired'
        END
      WHERE id = v_item.listing_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Reserved listing cannot be restored' USING ERRCODE = 'P0001'; END IF;
    END LOOP;
    UPDATE public.order_cancellation_requests
      SET resolved_at = now(), resolved_by = p_actor_id, resolution = 'accepted'
      WHERE order_id = p_order_id AND resolved_at IS NULL;
  ELSE
    RAISE EXCEPTION 'Actor is not authorized for this order transition' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.order_events (order_id, actor_id, event_type, from_status, to_status, reason)
  VALUES (p_order_id, p_actor_id, p_action, v_from, v_order.status, nullif(btrim(p_reason), ''));
  RETURN v_order;
END $$;

CREATE OR REPLACE FUNCTION public.request_order_cancellation(
  p_order_id uuid,
  p_actor_id uuid,
  p_reason text
) RETURNS public.order_cancellation_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_request public.order_cancellation_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR p_actor_id <> v_order.buyer_id THEN RAISE EXCEPTION 'Only the buyer can request cancellation' USING ERRCODE = 'P0001'; END IF;
  IF v_order.status IN ('order_completed', 'cancelled') THEN RAISE EXCEPTION 'Order is already final' USING ERRCODE = 'P0001'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 500 THEN RAISE EXCEPTION 'Reason must be 5 to 500 characters' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.order_cancellation_requests (order_id, actor_id, reason)
  VALUES (p_order_id, p_actor_id, btrim(p_reason)) RETURNING * INTO v_request;
  INSERT INTO public.order_events (order_id, actor_id, event_type, from_status, to_status, reason)
  VALUES (p_order_id, p_actor_id, 'cancellation_requested', v_order.status, v_order.status, btrim(p_reason));
  RETURN v_request;
END $$;

CREATE OR REPLACE FUNCTION public.report_order_no_show(
  p_order_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_payment_wait_hours integer,
  p_seller_stale_hours integer
) RETURNS public.order_no_show_reports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_report public.order_no_show_reports%ROWTYPE;
  v_type text;
  v_reported uuid;
  v_eligible timestamptz;
BEGIN
  IF p_payment_wait_hours NOT BETWEEN 1 AND 168 OR p_seller_stale_hours NOT BETWEEN 6 AND 336 THEN
    RAISE EXCEPTION 'No-show thresholds are outside configured safety bounds' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 500 THEN RAISE EXCEPTION 'Reason must be 5 to 500 characters' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;

  IF p_actor_id = v_order.seller_id AND v_order.payment_received_at IS NULL
     AND v_order.status IN ('awaiting_payment', 'preparing_order') THEN
    v_eligible := v_order.created_at + make_interval(hours => p_payment_wait_hours);
    IF now() < v_eligible THEN RAISE EXCEPTION 'Unpaid-buyer report is not eligible yet' USING ERRCODE = 'P0001'; END IF;
    v_type := 'buyer_unpaid'; v_reported := v_order.buyer_id;
  ELSIF p_actor_id = v_order.buyer_id AND v_order.status = 'payment_received'
     AND v_order.payment_received_at IS NOT NULL AND v_order.dropped_off_at IS NULL THEN
    v_eligible := v_order.payment_received_at + make_interval(hours => p_seller_stale_hours);
    IF now() < v_eligible THEN RAISE EXCEPTION 'Seller-stale report is not eligible yet' USING ERRCODE = 'P0001'; END IF;
    v_type := 'seller_stale_after_payment'; v_reported := v_order.seller_id;
  ELSE
    RAISE EXCEPTION 'Actor or order state is not eligible for a no-show report' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.order_no_show_reports (order_id, reporter_id, reported_user_id, report_type, reason, eligible_at)
  VALUES (p_order_id, p_actor_id, v_reported, v_type, btrim(p_reason), v_eligible)
  RETURNING * INTO v_report;
  INSERT INTO public.order_events (order_id, actor_id, event_type, from_status, to_status, reason)
  VALUES (p_order_id, p_actor_id, v_type, v_order.status, v_order.status, btrim(p_reason));
  RETURN v_report;
END $$;

REVOKE ALL ON FUNCTION public.checkout_orders(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_order(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_order_cancellation(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_order_no_show(uuid, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_orders(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_order(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_order_cancellation(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_order_no_show(uuid, uuid, text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.checkout_orders IS 'Service-role-only atomic seller-grouped checkout using trusted server price snapshots.';
COMMENT ON TABLE public.order_no_show_reports IS 'Bounded participant reports; eligibility thresholds are configurable by the server within SQL safety bounds.';

-- ============================================================================
-- SOURCE 16: supabase/migrations/20260717010000_phase40_expand.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Staged from supabase/migration-017-facebook-export-photo-versions.sql
-- Phase 40 expand migration: immutable condition-photo promotion and Facebook
-- export snapshots. This migration intentionally leaves the Phase 15 direct
-- mutation policies in place during the application deployment. Migration 018
-- contracts those legacy permissions after the new service-RPC application is
-- live and verified.

-- Composite ownership/version keys let the snapshot prove that its card, owner,
-- and photo path all refer to the same current canonical condition photo.
ALTER TABLE public.library_cards
  ADD CONSTRAINT library_cards_id_user_unique UNIQUE (id, user_id);

ALTER TABLE public.card_photos
  ADD CONSTRAINT card_photos_card_user_path_unique
  UNIQUE (library_card_id, user_id, storage_path);

CREATE TABLE public.fb_export_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  library_card_id       uuid NOT NULL UNIQUE,
  multiplier            numeric NOT NULL CHECK (multiplier > 0),
  ckd_usd_snapshot      numeric NOT NULL CHECK (ckd_usd_snapshot >= 0),
  myr_price_snapshot    numeric NOT NULL CHECK (myr_price_snapshot >= 0),
  generation_id         uuid NOT NULL,
  photo_storage_path    text NOT NULL,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fb_export_snapshot_card_owner_fk
    FOREIGN KEY (library_card_id, user_id)
    REFERENCES public.library_cards(id, user_id) ON DELETE CASCADE,
  CONSTRAINT fb_export_snapshot_canonical_photo_fk
    FOREIGN KEY (library_card_id, user_id, photo_storage_path)
    REFERENCES public.card_photos(library_card_id, user_id, storage_path)
    ON DELETE CASCADE
);

CREATE INDEX idx_fb_export_snapshots_user
  ON public.fb_export_snapshots(user_id);

ALTER TABLE public.fb_export_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner facebook export snapshots select"
  ON public.fb_export_snapshots
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Snapshot rows are generated values, not user-authored records. Authenticated
-- owners may read them, while the service-only RPCs below remain the only
-- insert/update/delete authority (including invalidation).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.fb_export_snapshots FROM anon, authenticated;
GRANT SELECT ON TABLE public.fb_export_snapshots TO authenticated;

CREATE OR REPLACE FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.fb_export_snapshots
  WHERE library_card_id = NEW.id
    AND user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change() FROM anon;
REVOKE ALL ON FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change() FROM authenticated;

CREATE TRIGGER invalidate_fb_export_snapshot_on_card_details_change
  AFTER UPDATE OF condition, foil ON public.library_cards
  FOR EACH ROW
  WHEN (
    OLD.condition IS DISTINCT FROM NEW.condition
    OR OLD.foil IS DISTINCT FROM NEW.foil
  )
  EXECUTE FUNCTION public.invalidate_fb_export_snapshot_on_card_details_change();

CREATE OR REPLACE FUNCTION public.promote_card_photo(
  p_user_id uuid,
  p_library_card_id uuid,
  p_storage_path text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous_path text;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  PERFORM 1
  FROM public.library_cards
  WHERE id = p_library_card_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'library card not found';
  END IF;

  IF p_storage_path !~ (
    '^' || p_user_id::text || '/' || p_library_card_id::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
  ) THEN
    RAISE EXCEPTION 'invalid photo candidate path';
  END IF;

  SELECT storage_path
  INTO v_previous_path
  FROM public.card_photos
  WHERE library_card_id = p_library_card_id
  FOR UPDATE;

  DELETE FROM public.fb_export_snapshots
  WHERE library_card_id = p_library_card_id
    AND user_id = p_user_id;

  INSERT INTO public.card_photos (user_id, library_card_id, storage_path)
  VALUES (p_user_id, p_library_card_id, p_storage_path)
  ON CONFLICT (library_card_id) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        storage_path = EXCLUDED.storage_path,
        created_at = now();

  RETURN v_previous_path;
END;
$$;

REVOKE ALL ON FUNCTION public.promote_card_photo(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_card_photo(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_card_photo(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.update_library_card_and_invalidate_export(
  p_user_id uuid,
  p_library_card_id uuid,
  p_updates jsonb
)
RETURNS public.library_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card public.library_cards;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  IF p_updates - ARRAY['quantity', 'condition', 'foil', 'starred'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unsupported library card update';
  END IF;

  UPDATE public.library_cards
  SET quantity = CASE WHEN p_updates ? 'quantity' THEN (p_updates->>'quantity')::integer ELSE quantity END,
      condition = CASE WHEN p_updates ? 'condition' THEN p_updates->>'condition' ELSE condition END,
      foil = CASE WHEN p_updates ? 'foil' THEN p_updates->>'foil' ELSE foil END,
      starred = CASE WHEN p_updates ? 'starred' THEN (p_updates->>'starred')::boolean ELSE starred END
  WHERE id = p_library_card_id
    AND user_id = p_user_id
  RETURNING * INTO v_card;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'library card not found';
  END IF;

  RETURN v_card;
END;
$$;

REVOKE ALL ON FUNCTION public.update_library_card_and_invalidate_export(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_library_card_and_invalidate_export(uuid, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_library_card_and_invalidate_export(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_card_photo_and_invalidate_export(
  p_user_id uuid,
  p_library_card_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_storage_path text;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  PERFORM 1 FROM public.library_cards
  WHERE id = p_library_card_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'library card not found'; END IF;

  DELETE FROM public.fb_export_snapshots
  WHERE library_card_id = p_library_card_id AND user_id = p_user_id;

  DELETE FROM public.card_photos
  WHERE library_card_id = p_library_card_id AND user_id = p_user_id
  RETURNING storage_path INTO v_storage_path;

  RETURN v_storage_path;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_card_photo_and_invalidate_export(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_card_photo_and_invalidate_export(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.delete_card_photo_and_invalidate_export(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.save_fb_export_snapshot(
  p_user_id uuid,
  p_library_card_id uuid,
  p_multiplier numeric,
  p_ckd_usd numeric,
  p_myr_price numeric,
  p_generation_id uuid,
  p_photo_storage_path text,
  p_condition text,
  p_foil text
)
RETURNS public.fb_export_snapshots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card public.library_cards;
  v_snapshot public.fb_export_snapshots;
BEGIN
  IF auth.jwt()->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  SELECT * INTO v_card
  FROM public.library_cards
  WHERE id = p_library_card_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'library card not found'; END IF;
  IF v_card.condition IS DISTINCT FROM p_condition OR v_card.foil IS DISTINCT FROM p_foil THEN
    RAISE EXCEPTION 'card details changed during generation';
  END IF;

  PERFORM 1
  FROM public.card_photos
  WHERE library_card_id = p_library_card_id
    AND user_id = p_user_id
    AND storage_path = p_photo_storage_path
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'condition photo changed during generation'; END IF;

  INSERT INTO public.fb_export_snapshots
    (user_id, library_card_id, multiplier, ckd_usd_snapshot, myr_price_snapshot,
     generation_id, photo_storage_path, generated_at)
  VALUES
    (p_user_id, p_library_card_id, p_multiplier, p_ckd_usd, p_myr_price,
     p_generation_id, p_photo_storage_path, now())
  ON CONFLICT (library_card_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    multiplier = EXCLUDED.multiplier,
    ckd_usd_snapshot = EXCLUDED.ckd_usd_snapshot,
    myr_price_snapshot = EXCLUDED.myr_price_snapshot,
    generation_id = EXCLUDED.generation_id,
    photo_storage_path = EXCLUDED.photo_storage_path,
    generated_at = EXCLUDED.generated_at
  RETURNING * INTO v_snapshot;

  RETURN v_snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.save_fb_export_snapshot(uuid, uuid, numeric, numeric, numeric, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_fb_export_snapshot(uuid, uuid, numeric, numeric, numeric, uuid, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.save_fb_export_snapshot(uuid, uuid, numeric, numeric, numeric, uuid, text, text, text) TO service_role;

-- ============================================================================
-- SOURCE 17: supabase/migrations/20260717011500_phase40_contract.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Staged from supabase/migration-018-facebook-export-photo-contract.sql
-- Phase 40 contract migration: remove the legacy authenticated mutation paths
-- only after the service-RPC application has deployed and passed smoke checks.

-- Phase 15 stored canonical photos at fixed legacy paths. Keep those existing
-- rows readable, but require every newly inserted or changed canonical row to
-- use an immutable, versioned path. NOT VALID skips the historical scan while
-- PostgreSQL still enforces the constraint for new/updated rows.
ALTER TABLE public.card_photos
  ADD CONSTRAINT card_photos_versioned_storage_path_check
  CHECK (
    storage_path ~ (
      '^' || user_id::text || '/' || library_card_id::text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
    )
  ) NOT VALID;

DROP POLICY IF EXISTS "owner card photos crud" ON public.card_photos;
DROP POLICY IF EXISTS "authenticated card photos select" ON public.card_photos;

CREATE POLICY "owner card photos select"
  ON public.card_photos
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.card_photos FROM anon, authenticated;
GRANT SELECT ON TABLE public.card_photos TO authenticated;

DROP POLICY IF EXISTS "owner update card photos" ON storage.objects;
DROP POLICY IF EXISTS "owner delete card photos" ON storage.objects;

-- ============================================================================
-- SOURCE 18: supabase/migrations/20260718000000_phase41_search_sort_hardening.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Phase 41: canonical rarity ordering and authenticated catalog-search plan.
-- Design only here; apply only through the approved migration gate.

ALTER TABLE public.card_index
  ADD COLUMN rarity_rank smallint
  GENERATED ALWAYS AS (
    CASE rarity
      WHEN 'common'   THEN 10::smallint
      WHEN 'uncommon' THEN 20::smallint
      WHEN 'rare'     THEN 30::smallint
      WHEN 'mythic'   THEN 40::smallint
      ELSE NULL::smallint
    END
  ) STORED;

COMMENT ON COLUMN public.card_index.rarity_rank IS
  'Canonical C/U/R/M order. special, bonus, and unknown rarities remain NULL and must be ordered NULLS LAST.';

CREATE INDEX idx_card_index_rarity_rank
  ON public.card_index (rarity_rank);

-- Existing intent was "signed-in users may read catalog". Express that as a
-- target role, not a per-row auth.role() predicate that blocks trigram plans.
ALTER POLICY "card_index read" ON public.card_index
  TO authenticated
  USING (true);

ANALYZE public.card_index;

-- ============================================================================
-- SOURCE 19: supabase/migrations/20260724000000_phase45_auctions_expand.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Phase 45A: Auctions foundation (expand-only). Authored per
-- Drops/phase45-auction-rev2-spec-20260723.md sections 3, 9, 10, 11.
-- DO NOT apply automatically. Dan applies this in the Supabase SQL editor
-- after reviewing the bootstrap conflict audit (see the SELECT after Part B)
-- and the claim_sales title audit (Part H), per the phase39/phase40 convention.
--
-- Deploy order (safe at each step via 42P01/42703 fallbacks in API code):
--   1. This migration (inert — no reads/writes from existing code touch these
--      new tables/columns until 45B/45C RPCs and routes ship).
--   2. 45B RPCs, 45C API routes.
--   3. UI phases behind the Auctions tab.
--   4. Sweep cron registered last (separate Dan-approved change).
--
-- Rollback boundary: schema rollback (drop new tables, drop follows.auction_id,
-- revert order_items column adds) is Dan-applied only; not included here.

-- ROLLOUT SEQUENCING RISK:
-- This migration seeds existing commitments at apply time. Between apply and
-- Phase 45D–45H going live (which wire all Singles/CS/checkout paths to
-- maintain reservations), new listings/orders will not be automatically
-- reflected. Operators must apply 45D–45H migrations without delay after this
-- migration. Do not enable auction writes until 45D–45H are live.

-- ============================================================
-- Part A — Shared cross-marketplace reservation (Fix 1 / E4)
-- ============================================================
-- Each (library_card_id, source_id) pair is unique. This permits a card to
-- have both an active listing reservation and an open order reservation during
-- a normal partial-fill state. The aggregate quantity invariant (sum of
-- reserved_quantity per card <= library_cards.quantity) is enforced in
-- service-role RPCs (45B), not in this table definition.
CREATE TABLE IF NOT EXISTS public.marketplace_card_reservations (
  library_card_id  uuid NOT NULL REFERENCES public.library_cards(id),
  owner_id         uuid NOT NULL REFERENCES public.profiles(id),
  source_kind      text NOT NULL CHECK (source_kind IN ('listing','auction','order')),
  source_id        uuid NOT NULL,
  reserved_quantity integer NOT NULL CHECK (reserved_quantity >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (library_card_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_mcr_owner  ON public.marketplace_card_reservations (owner_id);
CREATE INDEX IF NOT EXISTS idx_mcr_source ON public.marketplace_card_reservations (source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_mcr_card ON public.marketplace_card_reservations (library_card_id);

COMMENT ON TABLE public.marketplace_card_reservations IS
  'Cross-marketplace exclusivity invariant (Fix 1/E4). Service-role write-only; no client access. See Part J for RLS/grants.';

-- ============================================================
-- Part B — Reservation bootstrap (run once; seeds existing commitments)
-- ============================================================
-- Session-scoped audit log of any library_card_id that was already committed
-- to more than one active source when this ran. These rows are NOT inserted
-- into marketplace_card_reservations; Dan must resolve the underlying
-- double-commit manually before relying on the PK invariant for those cards.
-- Created unconditionally (outside the guarded block below) so the audit
-- SELECT after the DO block never fails, even on a re-run where the
-- bootstrap itself is skipped as a no-op.
CREATE TEMP TABLE IF NOT EXISTS phase45_reservation_conflicts (
  library_card_id      uuid,
  attempted_source_kind text,
  attempted_source_id   uuid,
  attempted_owner_id    uuid,
  attempted_quantity    integer,
  reason                text,
  logged_at             timestamptz DEFAULT now()
);
TRUNCATE phase45_reservation_conflicts;

-- Guarded so re-running this migration file is safe: the bootstrap only
-- executes while marketplace_card_reservations is still empty. Once real
-- traffic (or a re-run of this file) has populated it, this block is a
-- no-op on every subsequent run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.marketplace_card_reservations LIMIT 1) THEN
    -- Every active listing is seeded, including listings linked to an active
    -- Claim Sale. The UNION keeps the explicit Claim Sale pass idempotent when
    -- the same listing satisfies both bootstrap requirements.
    DROP TABLE IF EXISTS phase45_reservation_bootstrap_candidates;
    CREATE TEMP TABLE phase45_reservation_bootstrap_candidates ON COMMIT DROP AS
    SELECT l.library_card_id, l.user_id AS owner_id, 'listing'::text AS source_kind,
           l.id AS source_id, l.quantity AS reserved_quantity
    FROM public.listings l
    WHERE l.status = 'active'
    UNION
    SELECT l.library_card_id, l.user_id, 'listing'::text, l.id, l.quantity
    FROM public.listings l
    JOIN public.claim_sales cs ON cs.id = l.claim_sale_id
    WHERE l.status = 'active' AND cs.status = 'active'
    UNION ALL
    SELECT oi.library_card_id, o.seller_id, 'order'::text, oi.order_id,
           sum(oi.quantity)::integer
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status NOT IN ('order_completed', 'cancelled')
      AND oi.library_card_id IS NOT NULL
    GROUP BY oi.library_card_id, o.seller_id, oi.order_id;

    -- Log only duplicate (card, source) candidates. Different source_id values
    -- for the same card are valid and are intentionally both retained.
    INSERT INTO phase45_reservation_conflicts
      (library_card_id, attempted_source_kind, attempted_source_id,
       attempted_owner_id, attempted_quantity, reason)
    SELECT c.library_card_id, c.source_kind, c.source_id, c.owner_id,
           c.reserved_quantity,
           'reservation source already exists before bootstrap insert'
    FROM phase45_reservation_bootstrap_candidates c
    WHERE EXISTS (
      SELECT 1 FROM public.marketplace_card_reservations mcr
      WHERE mcr.library_card_id = c.library_card_id
        AND mcr.source_id = c.source_id
    )
    OR EXISTS (
      SELECT 1 FROM phase45_reservation_bootstrap_candidates other
      WHERE other.library_card_id = c.library_card_id
        AND other.source_id = c.source_id
        AND other.source_kind = c.source_kind
    );

    INSERT INTO public.marketplace_card_reservations
      (library_card_id, owner_id, source_kind, source_id, reserved_quantity)
    SELECT library_card_id, owner_id, source_kind, source_id, reserved_quantity
    FROM phase45_reservation_bootstrap_candidates
    ON CONFLICT (library_card_id, source_id) DO NOTHING;
  END IF;
END
$$;

-- Audit query: run in the same session as the DO block above (the temp table
-- is session-scoped). Empty result = clean bootstrap, safe to proceed. Any
-- rows here are pre-existing data conflicts that predate Phase 45 and must
-- be resolved by hand before the exclusivity invariant can be trusted for
-- those cards.
SELECT * FROM phase45_reservation_conflicts ORDER BY logged_at;

-- ============================================================
-- Part C — Auctions: one lot, one seller
-- ============================================================
CREATE TABLE IF NOT EXISTS public.auctions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  starting_bid_myr integer NOT NULL,
  buyout_myr       integer,
  bid_increment    text NOT NULL DEFAULT 'any',
  duration_hours   integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,                          -- null while draft
  expires_at       timestamptz,                          -- null while draft; set at publish
  -- one-time seller extension (E2)
  original_expires_at timestamptz,
  extension_minutes   integer NOT NULL DEFAULT 0,
  extended_at          timestamptz,
  extension_idempotency_key text,
  -- soft close (enrichment #4; Dan: 5-min window / +5 / +15 cap)
  soft_close_enabled  boolean NOT NULL DEFAULT false,
  soft_close_extension_minutes integer NOT NULL DEFAULT 0,
  -- denormalized bid state, maintained ONLY by place_auction_bid/buyout RPCs (45B)
  current_bid_myr  integer,
  current_bid_id   uuid,                                 -- FK added in Part F, after auction_bids exists
  bid_count        integer NOT NULL DEFAULT 0,
  winner_id        uuid REFERENCES public.profiles(id),
  won_at           timestamptz,
  settled_order_ids uuid[],
  settled_at       timestamptz,
  -- relist lineage (Fix 4)
  relisted_from_auction_id uuid REFERENCES public.auctions(id),
  CONSTRAINT chk_auctions_status CHECK (status IN
    ('draft', 'active', 'ended_sold', 'ended_pending_winner',
     'expired', 'relist_available', 'cancelled')),
  -- E1: whole Ringgit only.
  CONSTRAINT chk_auctions_starting_bid CHECK (starting_bid_myr >= 1),
  CONSTRAINT chk_auctions_buyout CHECK (
    buyout_myr IS NULL OR buyout_myr > starting_bid_myr
  ),
  CONSTRAINT chk_auctions_bid_increment CHECK (bid_increment IN ('any', '1', '5', '10')),
  CONSTRAINT chk_auctions_duration_hours CHECK (duration_hours IN (1, 3, 6, 12, 24)),
  CONSTRAINT chk_auctions_extension_minutes CHECK (extension_minutes IN (0, 15, 30, 60)),
  CONSTRAINT chk_auctions_soft_close_minutes CHECK (soft_close_extension_minutes IN (0, 5, 10, 15)),
  -- E6 / Fix 5: required seller-named title, 3-60 trimmed chars.
  CONSTRAINT chk_auctions_title_len CHECK (char_length(trim(title)) BETWEEN 3 AND 60)
);
CREATE INDEX IF NOT EXISTS idx_auctions_status_expires ON public.auctions (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_auctions_seller ON public.auctions (seller_id);
CREATE INDEX IF NOT EXISTS idx_auctions_active_created ON public.auctions (created_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_auctions_relist_lineage ON public.auctions (relisted_from_auction_id)
  WHERE relisted_from_auction_id IS NOT NULL;

COMMENT ON COLUMN public.auctions.status IS
  'cancelled is retained in the enum for a hypothetical future admin/support path only. It is not seller-reachable and not Phase 45 functionality (Fix 7 -- no seller cancellation of any kind).';
COMMENT ON TABLE public.auctions IS
  'Lot cap (max 20 distinct auction_items rows, max 100 total copies) is validated in the publish_auction RPC (45B), not as a table constraint — it depends on aggregating auction_items after insert.';

-- ============================================================
-- Part D — Auction items: immutable sale-time snapshot (Fix 2)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.auction_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id          uuid NOT NULL REFERENCES public.auctions(id) ON DELETE CASCADE,
  -- live pointer for reservation/settlement; nullable + SET NULL so history survives deletes
  library_card_id     uuid REFERENCES public.library_cards(id) ON DELETE SET NULL,
  quantity            integer NOT NULL,
  -- immutable snapshot captured at publish
  scryfall_id         text,
  card_name           text NOT NULL,
  set_code            text,
  set_name            text,
  collector_number    text,
  foil                boolean,
  condition           text,
  language            text,
  allocation_weight_myr integer,                         -- whole-RM cached value for per-line split
  CONSTRAINT chk_auction_items_quantity CHECK (quantity >= 1),
  UNIQUE (auction_id, library_card_id)                   -- one row per distinct card within an auction
);
CREATE INDEX IF NOT EXISTS idx_auction_items_auction ON public.auction_items (auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_items_card ON public.auction_items (library_card_id);

COMMENT ON COLUMN public.auction_items.library_card_id IS
  'Nullable with ON DELETE SET NULL (not CASCADE): deleting the live library card must not erase the immutable lot-item snapshot used for settlement history.';

-- ============================================================
-- Part E — Bids (append-only; never updated or deleted)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.auction_bids (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES public.auctions(id) ON DELETE CASCADE,
  bidder_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount_myr integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_auction_bids_amount CHECK (amount_myr >= 1)
);
-- Winner ordering: highest amount, earliest placed, then id — deterministic
CREATE INDEX IF NOT EXISTS idx_auction_bids_ordering
  ON public.auction_bids (auction_id, amount_myr DESC, created_at ASC, id ASC);
-- Activity Center (enrichment #1): latest bid per auction per bidder
CREATE INDEX IF NOT EXISTS idx_auction_bids_bidder
  ON public.auction_bids (bidder_id, created_at DESC);

-- ============================================================
-- Part F — FK: auctions.current_bid_id -> auction_bids.id
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.auctions'::regclass
      AND conname = 'fk_auctions_current_bid'
  ) THEN
    ALTER TABLE public.auctions
      ADD CONSTRAINT fk_auctions_current_bid
      FOREIGN KEY (current_bid_id) REFERENCES public.auction_bids(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- ============================================================
-- Part G — Follows: third target type, exact-one integrity (Sol §6.5)
-- ============================================================
ALTER TABLE public.follows ADD COLUMN IF NOT EXISTS auction_id uuid
  REFERENCES public.auctions(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_follows_auction
  ON public.follows (follower_id, auction_id) WHERE auction_id IS NOT NULL;

-- Replace the original OR-based target CHECK with exact-one in one block.
DO $$
DECLARE
  v_conname text;
BEGIN
  FOR v_conname IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.follows'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%followee_id%'
  LOOP
    EXECUTE 'ALTER TABLE public.follows DROP CONSTRAINT ' || quote_ident(v_conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.follows'::regclass
      AND conname = 'chk_follows_single_target'
  ) THEN
    ALTER TABLE public.follows
      ADD CONSTRAINT chk_follows_single_target
      CHECK (num_nonnulls(followee_id, claim_sale_id, auction_id) = 1);
  END IF;
END
$$;

-- ============================================================
-- Part H — Claim Sales title contract (E6 / Fix 5)
-- ============================================================
-- Audit: any existing claim_sales.title that falls outside the 3-60 contract.
SELECT id, user_id, title, char_length(trim(title)) AS trimmed_len
FROM public.claim_sales
WHERE char_length(trim(title)) < 3 OR char_length(trim(title)) > 60
ORDER BY created_at;

ALTER TABLE public.claim_sales ADD CONSTRAINT chk_claim_sale_title_length
  CHECK (char_length(trim(title)) BETWEEN 3 AND 60) NOT VALID;

-- Run after manually fixing any title rows returned by the audit query above.
-- ALTER TABLE public.claim_sales VALIDATE CONSTRAINT chk_claim_sale_title_length;

-- ============================================================
-- Part I — Order state machine: auction-aware (Fix 3)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.order_items') IS NOT NULL THEN
    IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_items'
      AND column_name = 'multiplier' AND is_nullable = 'NO'
    ) THEN
      ALTER TABLE public.order_items ALTER COLUMN multiplier DROP NOT NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_items'
        AND column_name = 'price_source'
    ) THEN
      ALTER TABLE public.order_items ADD COLUMN price_source text;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.order_items'::regclass
        AND conname = 'chk_order_items_price_source'
    ) THEN
      ALTER TABLE public.order_items
        ADD CONSTRAINT chk_order_items_price_source
        CHECK (price_source IN ('single_multiplier', 'auction_bid', 'auction_buyout'));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_items'
        AND column_name = 'auction_id'
    ) THEN
      ALTER TABLE public.order_items ADD COLUMN auction_id uuid
        REFERENCES public.auctions(id);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_items'
        AND column_name = 'auction_item_id'
    ) THEN
      ALTER TABLE public.order_items ADD COLUMN auction_item_id uuid
        REFERENCES public.auction_items(id);
    END IF;

    -- Safe, non-destructive backfill for existing Singles/Claim-Sale rows.
    UPDATE public.order_items
    SET price_source = 'single_multiplier'
    WHERE price_source IS NULL AND multiplier IS NOT NULL;

    -- Source-shape checks protect new rows while allowing an explicit later
    -- audit/validation pass to handle any legacy contradictions.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.order_items'::regclass
        AND conname = 'chk_order_items_single_multiplier_no_auction'
    ) THEN
      ALTER TABLE public.order_items
        ADD CONSTRAINT chk_order_items_single_multiplier_no_auction
        CHECK (price_source <> 'single_multiplier' OR auction_id IS NULL)
        NOT VALID;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.order_items'::regclass
        AND conname = 'chk_order_items_auction_no_multiplier'
    ) THEN
      ALTER TABLE public.order_items
        ADD CONSTRAINT chk_order_items_auction_no_multiplier
        CHECK (price_source NOT IN ('auction_bid', 'auction_buyout') OR multiplier IS NULL)
        NOT VALID;
    END IF;
  END IF;
END
$$;

-- After manually fixing any legacy rows returned by the source-shape audit:
-- ALTER TABLE public.order_items VALIDATE CONSTRAINT chk_order_items_single_multiplier_no_auction;
-- ALTER TABLE public.order_items VALIDATE CONSTRAINT chk_order_items_auction_no_multiplier;

-- ============================================================
-- Part J — RLS: owner-SELECT-only / no-owner-writes (Fix 7, Sol §6.2-6.4)
-- ============================================================
ALTER TABLE public.auctions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.auctions FROM PUBLIC;
REVOKE ALL ON public.auctions FROM anon, authenticated;

DROP POLICY IF EXISTS "owner auctions select" ON public.auctions;
CREATE POLICY "owner auctions select"
  ON public.auctions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = seller_id);

DROP POLICY IF EXISTS "authenticated auctions select active" ON public.auctions;
CREATE POLICY "authenticated auctions select active"
  ON public.auctions
  FOR SELECT
  TO authenticated
  USING (status NOT IN ('draft', 'cancelled'));

DROP POLICY IF EXISTS "anon auctions select active" ON public.auctions;
CREATE POLICY "anon auctions select active"
  ON public.auctions
  FOR SELECT TO anon
  USING (status NOT IN ('draft', 'cancelled'));

-- Owner gets SELECT only. All mutations via service-role RPCs (create,
-- publish, extend, relist, settle). No auction is seller-cancellable.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.auctions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.auctions TO anon, authenticated;

ALTER TABLE public.auction_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.auction_items FROM PUBLIC;
REVOKE ALL ON public.auction_items FROM anon, authenticated;

DROP POLICY IF EXISTS "authenticated auction items select" ON public.auction_items;
CREATE POLICY "authenticated auction items select"
  ON public.auction_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.auctions a
      WHERE a.id = auction_id
        AND (a.seller_id = auth.uid() OR a.status NOT IN ('draft', 'cancelled'))
    )
  );

-- No client writes — populated by publish/relist RPCs only (45B). Immutable
-- after publish.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.auction_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.auction_items TO authenticated;

ALTER TABLE public.auction_bids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated auction bids select" ON public.auction_bids;
REVOKE ALL ON TABLE public.auction_bids FROM PUBLIC, anon, authenticated;

ALTER TABLE public.marketplace_card_reservations ENABLE ROW LEVEL SECURITY;

-- No policies at all: service-role only (service_role bypasses RLS). Owner-
-- visible reservation state is surfaced through API responses (library
-- badges), never a direct table read.
REVOKE ALL ON TABLE public.marketplace_card_reservations FROM PUBLIC, anon, authenticated;

-- order_items' new columns (price_source, auction_id, auction_item_id) are
-- covered by the existing orders/order_items participant-read RLS policies
-- from migration 20260716000000_phase39_orders.sql — no new policy needed.

-- ============================================================
-- Part K — Verification (run after applying)
-- ============================================================
-- SELECT count(*) FROM public.auctions; -- expect 0
-- SELECT count(*) FROM public.marketplace_card_reservations; -- expect count of active listings/orders
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'auction_bids';
-- SELECT * FROM pg_policies WHERE tablename IN ('auctions','auction_items','auction_bids','marketplace_card_reservations');

-- ============================================================================
-- SOURCE 20: supabase/migrations/20260724000001_phase45_auctions_rpcs.sql
-- Included verbatim in the Phase 45C local-UAT squash.
-- ============================================================================
-- Phase 45B — service-role auction RPCs.
-- This migration is authored for manual review only. It does not apply SQL to a database.

-- 45A used a boolean auction_items.foil snapshot.  Replace it with the
-- three-valued live-card finish and add the same lossless snapshot to orders.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='auction_items' AND column_name='foil'
  ) THEN
    ALTER TABLE public.auction_items DROP COLUMN foil;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='auction_items' AND column_name='finish'
  ) THEN
    ALTER TABLE public.auction_items ADD COLUMN finish text NOT NULL DEFAULT 'normal';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.auction_items'::regclass
      AND conname='chk_auction_items_finish'
  ) THEN
    ALTER TABLE public.auction_items ADD CONSTRAINT chk_auction_items_finish
      CHECK (finish IN ('normal','foil','etched'));
  END IF;

  IF to_regclass('public.order_items') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='order_items' AND column_name='finish'
    ) THEN
      ALTER TABLE public.order_items ADD COLUMN finish text NOT NULL DEFAULT 'normal';
    END IF;
    -- Preserve the established Phase 39 snapshot for rows created before 45B.
    UPDATE public.order_items
    SET finish = CASE WHEN foil IN ('normal','foil','etched') THEN foil ELSE 'normal' END
    WHERE foil IS NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.order_items'::regclass
        AND conname='chk_order_items_finish'
    ) THEN
      ALTER TABLE public.order_items ADD CONSTRAINT chk_order_items_finish
        CHECK (finish IN ('normal','foil','etched'));
    END IF;
  END IF;
END $$;

-- Preserve the exact terminal outcome for idempotent replay.  The Phase 39
-- checkout_requests shape predates auction lazy-expiry outcomes and only
-- distinguishes processing/completed, so status alone cannot represent an
-- AUCTION_ENDED or CLAIM_WINDOW_EXPIRED completion.
ALTER TABLE public.checkout_requests
  ADD COLUMN IF NOT EXISTS result_code text;

-- Equal-by-quantity allocation.  line_sen is authoritative for order_items;
-- allocation_weight_myr is the whole-MYR line snapshot required by
-- the foundation column.  The one-sen floor is applied before the remainder,
-- so a skewed lot can never generate a zero-value order line.
-- Accepted W3 design warning: allocation_weight_myr is a whole-MYR ceiling
-- snapshot and is intentionally not an exact sen-level price representation.
CREATE OR REPLACE FUNCTION public.phase45_allocate_auction_lines(
  p_auction_id uuid, p_total_myr integer
) RETURNS TABLE(auction_item_id uuid, line_sen bigint, allocation_myr integer)
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH item_base AS (
    SELECT ai.id, ai.quantity::bigint AS quantity,
      (sum(ai.quantity) OVER ())::bigint AS total_quantity,
      (count(*) OVER ())::bigint AS item_count,
      p_total_myr::bigint * 100 AS total_sen,
      row_number() OVER (ORDER BY ai.id) AS rn
    FROM public.auction_items ai
    WHERE ai.auction_id = p_auction_id
  ),
  floored AS (
    SELECT ib.*, (1::bigint + floor(
      ib.quantity::numeric * (ib.total_sen - ib.item_count)
      / NULLIF(ib.total_quantity, 0)
    )::bigint) AS base_sen
    FROM item_base ib
    WHERE ib.total_sen >= ib.item_count
  ),
  remainder AS (
    SELECT f.*, f.total_sen - sum(f.base_sen) OVER () AS remainder_sen
    FROM floored f
  ),
  final_lines AS (
    SELECT r.id AS auction_item_id,
      r.base_sen + CASE WHEN r.rn=1 THEN r.remainder_sen ELSE 0 END AS line_sen
    FROM remainder r
  )
  SELECT fl.auction_item_id, fl.line_sen,
    greatest(1, ceil(fl.line_sen::numeric / 100)::integer) AS allocation_myr
  FROM final_lines fl
  ORDER BY fl.auction_item_id
$$;

-- §4.1 — Draft creation.
CREATE OR REPLACE FUNCTION public.create_auction_draft(
  p_seller_id uuid, p_title text, p_starting_bid_myr integer,
  p_bid_increment text, p_duration_hours integer,
  p_buyout_myr integer DEFAULT NULL,
  p_soft_close_enabled boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_title text;
  v_id uuid;
BEGIN
  v_title := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  IF char_length(v_title) < 3 THEN RAISE EXCEPTION 'TITLE_TOO_SHORT' USING ERRCODE = 'P0001'; END IF;
  IF char_length(v_title) > 60 THEN RAISE EXCEPTION 'TITLE_TOO_LONG' USING ERRCODE = 'P0001'; END IF;
  IF p_bid_increment IS NULL OR p_bid_increment NOT IN ('any','1','5','10') THEN RAISE EXCEPTION 'INVALID_INCREMENT' USING ERRCODE = 'P0001'; END IF;
  IF p_duration_hours IS NULL OR p_duration_hours NOT IN (1,3,6,12,24) THEN RAISE EXCEPTION 'INVALID_DURATION' USING ERRCODE = 'P0001'; END IF;
  IF p_starting_bid_myr IS NULL OR p_starting_bid_myr < 1 THEN RAISE EXCEPTION 'STARTING_BID_TOO_LOW' USING ERRCODE = 'P0001'; END IF;
  IF p_starting_bid_myr > 99999 THEN RAISE EXCEPTION 'STARTING_BID_TOO_HIGH' USING ERRCODE = 'P0001'; END IF;
  IF p_buyout_myr IS NOT NULL AND p_buyout_myr <= p_starting_bid_myr THEN RAISE EXCEPTION 'BUYOUT_MUST_EXCEED_START' USING ERRCODE = 'P0001'; END IF;
  IF p_buyout_myr IS NOT NULL AND p_buyout_myr > 99999 THEN RAISE EXCEPTION 'BUYOUT_TOO_HIGH' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_seller_id AND p.merchant_profile_completed_at IS NOT NULL
      AND nullif(btrim(p.merchant_bank_name), '') IS NOT NULL
      AND nullif(btrim(p.merchant_account_name), '') IS NOT NULL
      AND (nullif(btrim(p.merchant_account_number), '') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id), '') IS NOT NULL)
  ) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO public.auctions (seller_id, title, status, starting_bid_myr, buyout_myr,
    bid_increment, duration_hours, soft_close_enabled)
  VALUES (p_seller_id, v_title, 'draft', p_starting_bid_myr, p_buyout_myr,
    p_bid_increment, p_duration_hours, coalesce(p_soft_close_enabled, false))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- §4.1 — Draft update.
CREATE OR REPLACE FUNCTION public.update_auction_draft(
  p_seller_id uuid, p_auction_id uuid, p_title text DEFAULT NULL,
  p_starting_bid_myr integer DEFAULT NULL, p_bid_increment text DEFAULT NULL,
  p_duration_hours integer DEFAULT NULL, p_buyout_myr integer DEFAULT NULL,
  p_soft_close_enabled boolean DEFAULT NULL, p_clear_buyout boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v public.auctions%ROWTYPE;
  v_title text;
  v_start integer;
  v_inc text;
  v_duration integer;
  v_buyout integer;
BEGIN
  SELECT * INTO v FROM public.auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v.seller_id <> p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = 'P0001'; END IF;
  IF v.status <> 'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  v_title := btrim(regexp_replace(coalesce(p_title, v.title), '\s+', ' ', 'g'));
  v_start := coalesce(p_starting_bid_myr, v.starting_bid_myr);
  v_inc := coalesce(p_bid_increment, v.bid_increment);
  v_duration := coalesce(p_duration_hours, v.duration_hours);
  v_buyout := CASE WHEN coalesce(p_clear_buyout, false) THEN NULL
                   ELSE coalesce(p_buyout_myr, v.buyout_myr) END;
  IF char_length(v_title) < 3 THEN RAISE EXCEPTION 'TITLE_TOO_SHORT' USING ERRCODE = 'P0001'; END IF;
  IF char_length(v_title) > 60 THEN RAISE EXCEPTION 'TITLE_TOO_LONG' USING ERRCODE = 'P0001'; END IF;
  IF v_inc NOT IN ('any','1','5','10') THEN RAISE EXCEPTION 'INVALID_INCREMENT' USING ERRCODE = 'P0001'; END IF;
  IF v_duration NOT IN (1,3,6,12,24) THEN RAISE EXCEPTION 'INVALID_DURATION' USING ERRCODE = 'P0001'; END IF;
  IF v_start < 1 THEN RAISE EXCEPTION 'STARTING_BID_TOO_LOW' USING ERRCODE = 'P0001'; END IF;
  IF v_start > 99999 THEN RAISE EXCEPTION 'STARTING_BID_TOO_HIGH' USING ERRCODE = 'P0001'; END IF;
  IF v_buyout IS NOT NULL AND v_buyout <= v_start THEN RAISE EXCEPTION 'BUYOUT_MUST_EXCEED_START' USING ERRCODE = 'P0001'; END IF;
  IF v_buyout IS NOT NULL AND v_buyout > 99999 THEN RAISE EXCEPTION 'BUYOUT_TOO_HIGH' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.auctions SET title = v_title, starting_bid_myr = v_start,
    bid_increment = v_inc, duration_hours = v_duration, buyout_myr = v_buyout,
    soft_close_enabled = coalesce(p_soft_close_enabled, soft_close_enabled)
  WHERE id = p_auction_id;
END $$;

-- §4.1 — Draft lot assembly.
CREATE OR REPLACE FUNCTION public.add_auction_draft_item(
  p_seller_id uuid, p_auction_id uuid, p_library_card_id uuid, p_quantity integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a public.auctions%ROWTYPE;
  v_c public.library_cards%ROWTYPE;
  v_items integer;
  v_copies integer;
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_a.seller_id <> p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = 'P0001'; END IF;
  IF v_a.status <> 'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  IF p_quantity IS NULL OR p_quantity < 1 THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_c FROM public.library_cards WHERE id = p_library_card_id FOR UPDATE;
  IF NOT FOUND OR v_c.user_id <> p_seller_id THEN RAISE EXCEPTION 'CARD_NOT_OWNED' USING ERRCODE = 'P0001'; END IF;
  IF p_quantity > v_c.quantity THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.auction_items WHERE auction_id = p_auction_id AND library_card_id = p_library_card_id) THEN
    RAISE EXCEPTION 'DUPLICATE_LOT_ITEM' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*), coalesce(sum(quantity), 0) INTO v_items, v_copies FROM public.auction_items WHERE auction_id = p_auction_id;
  IF v_items + 1 > 20 THEN RAISE EXCEPTION 'LOT_TOO_MANY_ITEMS' USING ERRCODE = 'P0001'; END IF;
  IF v_copies + p_quantity > 100 THEN RAISE EXCEPTION 'LOT_TOO_MANY_COPIES' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.card_photos WHERE library_card_id = p_library_card_id) THEN
    RAISE EXCEPTION 'PHOTO_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- card_name is NOT NULL in the 45A shape, so draft rows carry the current catalog name.
  INSERT INTO public.auction_items (auction_id, library_card_id, quantity, card_name)
  SELECT p_auction_id, v_c.id, p_quantity, ci.name
  FROM public.card_index ci WHERE ci.scryfall_id = v_c.scryfall_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARD_NOT_OWNED' USING ERRCODE = 'P0001'; END IF;
END $$;

-- Free draft editing: remove an existing item or replace its quantity.
DROP FUNCTION IF EXISTS public.remove_auction_draft_item(uuid, uuid);
CREATE OR REPLACE FUNCTION public.remove_auction_draft_item(
  p_seller_id uuid, p_auction_id uuid, p_library_card_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_a public.auctions%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.seller_id<>p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE='P0001'; END IF;
  IF v_a.status<>'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE='P0001'; END IF;
  DELETE FROM public.auction_items WHERE auction_id=p_auction_id AND library_card_id=p_library_card_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'LOT_ITEM_NOT_FOUND' USING ERRCODE='P0001'; END IF;
END $$;

DROP FUNCTION IF EXISTS public.update_auction_draft_item(uuid, uuid, integer);
CREATE OR REPLACE FUNCTION public.update_auction_draft_item(
  p_seller_id uuid, p_auction_id uuid, p_library_card_id uuid, p_quantity integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_a public.auctions%ROWTYPE; v_c public.library_cards%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.seller_id<>p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE='P0001'; END IF;
  IF v_a.status<>'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE='P0001'; END IF;
  IF p_quantity IS NULL OR p_quantity<1 THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_c FROM public.library_cards WHERE id=p_library_card_id FOR UPDATE;
  IF NOT FOUND OR v_c.user_id<>p_seller_id OR p_quantity>v_c.quantity THEN RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE='P0001'; END IF;
  UPDATE public.auction_items SET quantity=p_quantity
  WHERE auction_id=p_auction_id AND library_card_id=p_library_card_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'LOT_ITEM_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF (SELECT coalesce(sum(quantity),0) FROM public.auction_items WHERE auction_id=p_auction_id)>100 THEN
    RAISE EXCEPTION 'LOT_TOO_MANY_COPIES' USING ERRCODE='P0001';
  END IF;
END $$;

-- §4.1 — Atomic draft publish and reservation.
CREATE OR REPLACE FUNCTION public.publish_auction(p_seller_id uuid, p_auction_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a public.auctions%ROWTYPE;
  v_i public.auction_items%ROWTYPE;
  v_c public.library_cards%ROWTYPE;
  v_now timestamptz := now();
  v_exp timestamptz;
  v_items integer;
  v_copies integer;
  v_reserved integer;
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_a.seller_id <> p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE = 'P0001'; END IF;
  IF v_a.status <> 'draft' THEN RAISE EXCEPTION 'AUCTION_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*), coalesce(sum(quantity),0) INTO v_items, v_copies FROM public.auction_items WHERE auction_id = p_auction_id;
  IF v_items = 0 THEN RAISE EXCEPTION 'NO_LOT_ITEMS' USING ERRCODE = 'P0001'; END IF;
  IF v_items > 20 THEN RAISE EXCEPTION 'LOT_TOO_MANY_ITEMS' USING ERRCODE = 'P0001'; END IF;
  IF v_copies > 100 THEN RAISE EXCEPTION 'LOT_TOO_MANY_COPIES' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.auction_items WHERE auction_id = p_auction_id GROUP BY library_card_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'DUPLICATE_LOT_ITEM' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = p_seller_id AND p.merchant_profile_completed_at IS NOT NULL
      AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL
      AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)
  ) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE = 'P0001'; END IF;

  -- Deterministic card lock order is the concurrency boundary for inventory.
  FOR v_c IN SELECT lc.* FROM public.library_cards lc JOIN public.auction_items ai ON ai.library_card_id = lc.id
    WHERE ai.auction_id = p_auction_id ORDER BY lc.id FOR UPDATE LOOP NULL; END LOOP;
  FOR v_i IN SELECT * FROM public.auction_items WHERE auction_id = p_auction_id ORDER BY library_card_id NULLS LAST LOOP
    IF v_i.library_card_id IS NULL THEN RAISE EXCEPTION 'CARD_NOT_OWNED' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_c FROM public.library_cards WHERE id = v_i.library_card_id FOR UPDATE;
    IF NOT FOUND OR v_c.user_id <> p_seller_id THEN RAISE EXCEPTION 'CARD_NOT_OWNED' USING ERRCODE = 'P0001'; END IF;
    IF v_i.quantity < 1 OR v_i.quantity > v_c.quantity THEN RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.card_photos WHERE library_card_id = v_c.id) THEN RAISE EXCEPTION 'PHOTO_REQUIRED' USING ERRCODE = 'P0001'; END IF;
    SELECT coalesce(sum(reserved_quantity),0) INTO v_reserved FROM public.marketplace_card_reservations WHERE library_card_id = v_c.id;
    IF v_reserved + v_i.quantity > v_c.quantity THEN RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.auction_items ai SET scryfall_id = v_c.scryfall_id::text,
      card_name = ci.name, set_code = ci.set_code, set_name = ci.set_name,
      collector_number = ci.collector_number, finish = v_c.foil,
      condition = v_c.condition, language = v_c.language,
      allocation_weight_myr = NULL
    FROM public.card_index ci WHERE ai.id = v_i.id AND ci.scryfall_id = v_c.scryfall_id;
    BEGIN
      INSERT INTO public.marketplace_card_reservations
        (library_card_id, owner_id, source_kind, source_id, reserved_quantity)
      VALUES (v_c.id, p_seller_id, 'auction', p_auction_id, v_i.quantity);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE = 'P0001';
    END;
  END LOOP;
  v_exp := v_now + make_interval(hours => v_a.duration_hours);
  UPDATE public.auctions SET status='active', published_at=v_now, expires_at=v_exp, original_expires_at=v_exp
  WHERE id = p_auction_id;
  RETURN jsonb_build_object('auction_id', p_auction_id, 'expires_at', v_exp,
    'item_count', v_items, 'total_quantity', v_copies);
END $$;

-- §4.2 — Bid placement, soft close, and lazy expiry.
CREATE OR REPLACE FUNCTION public.place_auction_bid(
  p_auction_id uuid, p_bidder_id uuid, p_amount_myr integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a public.auctions%ROWTYPE;
  v_floor integer;
  v_step integer;
  v_bid uuid;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.status='active' AND v_a.expires_at <= v_now THEN
    IF v_a.bid_count=0 THEN
      UPDATE public.auctions SET status='expired' WHERE id=p_auction_id;
      DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=p_auction_id;
    ELSE
      SELECT bidder_id INTO v_a.winner_id FROM public.auction_bids WHERE id=v_a.current_bid_id;
      UPDATE public.auctions SET status='ended_pending_winner', winner_id=v_a.winner_id, won_at=v_a.expires_at WHERE id=p_auction_id;
    END IF;
    RETURN jsonb_build_object('result_code','AUCTION_ENDED','auction_id',p_auction_id,
      'status',CASE WHEN v_a.bid_count=0 THEN 'expired' ELSE 'ended_pending_winner' END);
  END IF;
  IF v_a.status <> 'active' OR v_a.expires_at <= v_now THEN RAISE EXCEPTION 'AUCTION_ENDED' USING ERRCODE='P0001'; END IF;
  IF p_bidder_id = v_a.seller_id THEN RAISE EXCEPTION 'SELLER_CANNOT_BID' USING ERRCODE='P0001'; END IF;
  IF p_amount_myr IS NULL OR p_amount_myr < 1 THEN RAISE EXCEPTION 'FRACTIONAL_AMOUNT' USING ERRCODE='P0001'; END IF;
  v_step := CASE v_a.bid_increment WHEN '5' THEN 5 WHEN '10' THEN 10 ELSE 1 END;
  v_floor := CASE WHEN v_a.bid_count=0 THEN v_a.starting_bid_myr ELSE v_a.current_bid_myr + v_step END;
  IF v_floor > 99999 OR p_amount_myr > 99999 THEN
    RAISE EXCEPTION 'BID_TOO_HIGH' USING ERRCODE='P0001';
  END IF;
  IF p_amount_myr < v_floor THEN
    RAISE EXCEPTION 'BID_TOO_LOW' USING ERRCODE='P0001', DETAIL=jsonb_build_object('floor',v_floor,'current_bid_myr',v_a.current_bid_myr)::text;
  END IF;
  IF v_a.buyout_myr IS NOT NULL AND p_amount_myr >= v_a.buyout_myr THEN RAISE EXCEPTION 'USE_BUYOUT' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.auction_bids(auction_id,bidder_id,amount_myr) VALUES(p_auction_id,p_bidder_id,p_amount_myr) RETURNING id INTO v_bid;
  UPDATE public.auctions SET current_bid_myr=p_amount_myr,current_bid_id=v_bid,bid_count=bid_count+1,
    expires_at=CASE WHEN soft_close_enabled AND expires_at-v_now <= interval '5 minutes' AND soft_close_extension_minutes < 15 THEN expires_at+interval '5 minutes' ELSE expires_at END,
    soft_close_extension_minutes=CASE WHEN soft_close_enabled AND expires_at-v_now <= interval '5 minutes' AND soft_close_extension_minutes < 15 THEN least(soft_close_extension_minutes+5,15) ELSE soft_close_extension_minutes END
  WHERE id=p_auction_id RETURNING * INTO v_a;
  RETURN jsonb_build_object('bid_id',v_bid,'current_bid_myr',v_a.current_bid_myr,'bid_count',v_a.bid_count,'expires_at',v_a.expires_at,'soft_close_extension_minutes',v_a.soft_close_extension_minutes);
END $$;

-- §4.3 — Buyout checkout and idempotency.
CREATE OR REPLACE FUNCTION public.checkout_auction_buyout(
  p_buyer_id uuid, p_idempotency_key uuid, p_pickup_location_id uuid, p_auction_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_a public.auctions%ROWTYPE; v_req public.checkout_requests%ROWTYPE; v_order uuid; v_i public.auction_items%ROWTYPE;
  v_count integer; v_total_sen bigint; v_alloc record; v_v uuid[]:='{}';
BEGIN
  INSERT INTO public.checkout_requests(buyer_id,idempotency_key) VALUES(p_buyer_id,p_idempotency_key) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN SELECT * INTO v_req FROM public.checkout_requests WHERE buyer_id=p_buyer_id AND idempotency_key=p_idempotency_key FOR UPDATE; IF v_req.status='completed' THEN RETURN jsonb_build_object('result_code',coalesce(v_req.result_code,'CHECKOUT_COMPLETE'),'order_ids',to_jsonb(v_req.order_ids)); END IF; RAISE EXCEPTION 'CHECKOUT_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.status='active' AND v_a.expires_at<=now() THEN
    IF v_a.bid_count=0 THEN UPDATE public.auctions SET status='expired' WHERE id=p_auction_id; DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=p_auction_id;
    ELSE SELECT bidder_id INTO v_a.winner_id FROM public.auction_bids WHERE id=v_a.current_bid_id; UPDATE public.auctions SET status='ended_pending_winner',winner_id=v_a.winner_id,won_at=v_a.expires_at WHERE id=p_auction_id; END IF;
    UPDATE public.checkout_requests SET status='completed',result_code='AUCTION_ENDED',order_ids='{}',completed_at=now()
    WHERE buyer_id=p_buyer_id AND idempotency_key=p_idempotency_key;
    -- Keep lazy-expiry's first terminal response byte-for-byte equivalent to
    -- the idempotent replay response.  There is no order to report here.
    RETURN jsonb_build_object('result_code','AUCTION_ENDED','order_ids','[]'::jsonb);
  END IF;
  IF v_a.status<>'active' OR v_a.expires_at<=now() THEN RAISE EXCEPTION 'AUCTION_ENDED' USING ERRCODE='P0001'; END IF;
  IF v_a.buyout_myr IS NULL THEN RAISE EXCEPTION 'BUYOUT_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
  IF p_buyer_id=v_a.seller_id THEN RAISE EXCEPTION 'SELLER_CANNOT_BUY' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pickup_locations WHERE id=p_pickup_location_id AND active) THEN RAISE EXCEPTION 'PICKUP_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_a.seller_id AND p.merchant_profile_completed_at IS NOT NULL AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE='P0001'; END IF;
  SELECT count(*) INTO v_count FROM public.auction_items WHERE auction_id=p_auction_id;
  v_total_sen := v_a.buyout_myr::bigint * 100;
  IF v_count=0 OR v_total_sen < v_count THEN RAISE EXCEPTION 'ALLOCATION_TOO_SMALL' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.orders(buyer_id,seller_id,pickup_location_id,total_myr) VALUES(p_buyer_id,v_a.seller_id,p_pickup_location_id,v_a.buyout_myr) RETURNING id INTO v_order; v_v:=array_append(v_v,v_order);
  FOR v_alloc IN SELECT * FROM public.phase45_allocate_auction_lines(p_auction_id,v_a.buyout_myr) LOOP
    SELECT * INTO v_i FROM public.auction_items WHERE id=v_alloc.auction_item_id;
    UPDATE public.auction_items SET allocation_weight_myr=v_alloc.allocation_myr WHERE id=v_i.id;
    INSERT INTO public.order_items(order_id,library_card_id,quantity,unit_myr,line_myr,multiplier,price_source,auction_id,auction_item_id,scryfall_id,card_name,set_code,set_name,collector_number,finish,condition)
    VALUES(v_order,v_i.library_card_id,v_i.quantity,(v_alloc.line_sen::numeric/100)/v_i.quantity,v_alloc.line_sen::numeric/100,NULL,'auction_buyout',p_auction_id,v_i.id,v_i.scryfall_id::uuid,v_i.card_name,v_i.set_code,v_i.set_name,v_i.collector_number,v_i.finish,v_i.condition);
  END LOOP;
  UPDATE public.marketplace_card_reservations SET source_kind='order',source_id=v_order WHERE source_kind='auction' AND source_id=p_auction_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (SELECT count(*) FROM public.auction_items WHERE auction_id=p_auction_id) THEN RAISE EXCEPTION 'RESERVATION_TRANSFER_FAILED' USING ERRCODE='P0001'; END IF;
  UPDATE public.auctions SET status='ended_sold',winner_id=p_buyer_id,won_at=now(),settled_order_ids=v_v,settled_at=now() WHERE id=p_auction_id;
  INSERT INTO public.order_events(order_id,actor_id,event_type,to_status) VALUES(v_order,p_buyer_id,'checkout_created','awaiting_payment');
  UPDATE public.checkout_requests SET status='completed',result_code='CHECKOUT_COMPLETE',order_ids=v_v,completed_at=now() WHERE buyer_id=p_buyer_id AND idempotency_key=p_idempotency_key;
  RETURN jsonb_build_object('result_code','CHECKOUT_COMPLETE','order_ids',to_jsonb(v_v));
END $$;

-- §4.6 — Winner claim checkout.
CREATE OR REPLACE FUNCTION public.checkout_auction_claim(
  p_winner_id uuid, p_idempotency_key uuid, p_pickup_location_id uuid, p_auction_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_a public.auctions%ROWTYPE; v_req public.checkout_requests%ROWTYPE; v_order uuid; v_i public.auction_items%ROWTYPE; v_v uuid[]:='{}'; v_count integer; v_total_sen bigint; v_alloc record;
BEGIN
  INSERT INTO public.checkout_requests(buyer_id,idempotency_key) VALUES(p_winner_id,p_idempotency_key) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN SELECT * INTO v_req FROM public.checkout_requests WHERE buyer_id=p_winner_id AND idempotency_key=p_idempotency_key FOR UPDATE; IF v_req.status='completed' THEN RETURN jsonb_build_object('result_code',coalesce(v_req.result_code,'CHECKOUT_COMPLETE'),'order_ids',to_jsonb(v_req.order_ids)); END IF; RAISE EXCEPTION 'CHECKOUT_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_a FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_a.status<>'ended_pending_winner' OR v_a.winner_id<>p_winner_id THEN RAISE EXCEPTION 'NOT_WINNER' USING ERRCODE='P0001'; END IF;
  IF v_a.won_at IS NULL OR v_a.won_at+interval '24 hours'<=now() THEN
    UPDATE public.auctions SET status='relist_available' WHERE id=p_auction_id;
    DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=p_auction_id;
    UPDATE public.checkout_requests SET status='completed',result_code='CLAIM_WINDOW_EXPIRED',order_ids='{}',completed_at=now()
    WHERE buyer_id=p_winner_id AND idempotency_key=p_idempotency_key;
    -- Keep lazy claim expiry's first terminal response byte-for-byte
    -- equivalent to the idempotent replay response.
    RETURN jsonb_build_object('result_code','CLAIM_WINDOW_EXPIRED','order_ids','[]'::jsonb);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pickup_locations WHERE id=p_pickup_location_id AND active) THEN RAISE EXCEPTION 'PICKUP_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_a.seller_id AND p.merchant_profile_completed_at IS NOT NULL AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE='P0001'; END IF;
  SELECT count(*) INTO v_count FROM public.auction_items WHERE auction_id=p_auction_id;
  v_total_sen := v_a.current_bid_myr::bigint * 100;
  IF v_count=0 OR v_total_sen < v_count THEN RAISE EXCEPTION 'ALLOCATION_TOO_SMALL' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.orders(buyer_id,seller_id,pickup_location_id,total_myr) VALUES(p_winner_id,v_a.seller_id,p_pickup_location_id,v_a.current_bid_myr) RETURNING id INTO v_order; v_v:=array_append(v_v,v_order);
  FOR v_alloc IN SELECT * FROM public.phase45_allocate_auction_lines(p_auction_id,v_a.current_bid_myr) LOOP
    SELECT * INTO v_i FROM public.auction_items WHERE id=v_alloc.auction_item_id;
    UPDATE public.auction_items SET allocation_weight_myr=v_alloc.allocation_myr WHERE id=v_i.id;
    INSERT INTO public.order_items(order_id,library_card_id,quantity,unit_myr,line_myr,multiplier,price_source,auction_id,auction_item_id,scryfall_id,card_name,set_code,set_name,collector_number,finish,condition)
    VALUES(v_order,v_i.library_card_id,v_i.quantity,(v_alloc.line_sen::numeric/100)/v_i.quantity,v_alloc.line_sen::numeric/100,NULL,'auction_bid',p_auction_id,v_i.id,v_i.scryfall_id::uuid,v_i.card_name,v_i.set_code,v_i.set_name,v_i.collector_number,v_i.finish,v_i.condition);
  END LOOP;
  UPDATE public.marketplace_card_reservations SET source_kind='order',source_id=v_order WHERE source_kind='auction' AND source_id=p_auction_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (SELECT count(*) FROM public.auction_items WHERE auction_id=p_auction_id) THEN RAISE EXCEPTION 'RESERVATION_TRANSFER_FAILED' USING ERRCODE='P0001'; END IF;
  UPDATE public.auctions SET status='ended_sold',settled_order_ids=v_v,settled_at=now() WHERE id=p_auction_id;
  INSERT INTO public.order_events(order_id,actor_id,event_type,to_status) VALUES(v_order,p_winner_id,'checkout_created','awaiting_payment');
  UPDATE public.checkout_requests SET status='completed',result_code='CHECKOUT_COMPLETE',order_ids=v_v,completed_at=now() WHERE buyer_id=p_winner_id AND idempotency_key=p_idempotency_key;
  RETURN jsonb_build_object('result_code','CHECKOUT_COMPLETE','order_ids',to_jsonb(v_v));
END $$;

-- §4.5 — One-time manual seller extension.
CREATE OR REPLACE FUNCTION public.extend_auction(
  p_auction_id uuid, p_seller_id uuid, p_extension_minutes integer, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.auctions%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.auctions WHERE id=p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v.seller_id<>p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE='P0001'; END IF;
  IF v.status<>'active' OR v.expires_at<=now() THEN RAISE EXCEPTION 'AUCTION_ENDED' USING ERRCODE='P0001'; END IF;
  IF v.extended_at IS NOT NULL THEN
    IF v.extension_idempotency_key = p_idempotency_key THEN
      RETURN jsonb_build_object('expires_at',v.expires_at,'extension_minutes',v.extension_minutes,'extended_at',v.extended_at);
    END IF;
    RAISE EXCEPTION 'EXTENSION_ALREADY_USED' USING ERRCODE='P0001';
  END IF;
  IF p_extension_minutes NOT IN (15,30,60) THEN RAISE EXCEPTION 'INVALID_EXTENSION' USING ERRCODE='P0001'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE='P0001'; END IF;
  UPDATE public.auctions SET expires_at=expires_at+make_interval(mins=>p_extension_minutes),extension_minutes=p_extension_minutes,extended_at=now(),extension_idempotency_key=p_idempotency_key WHERE id=p_auction_id RETURNING * INTO v;
  RETURN jsonb_build_object('expires_at',v.expires_at,'extension_minutes',v.extension_minutes,'extended_at',v.extended_at);
END $$;

-- §4.8 — Relist as a new auction record.
CREATE OR REPLACE FUNCTION public.relist_auction(p_seller_id uuid,p_old_auction_id uuid,p_duration_hours integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old public.auctions%ROWTYPE; v_i public.auction_items%ROWTYPE; v_c public.library_cards%ROWTYPE; v_new uuid; v_exp timestamptz; v_bad jsonb:='[]'; v_reason text; v_name text;
BEGIN
  SELECT * INTO v_old FROM public.auctions WHERE id=p_old_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUCTION_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF v_old.seller_id<>p_seller_id THEN RAISE EXCEPTION 'NOT_OWNER' USING ERRCODE='P0001'; END IF;
  IF v_old.status NOT IN ('expired','relist_available') THEN RAISE EXCEPTION 'AUCTION_NOT_RELISTABLE' USING ERRCODE='P0001'; END IF;
  IF p_duration_hours NOT IN (1,3,6,12,24) THEN RAISE EXCEPTION 'INVALID_DURATION' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=p_seller_id AND p.merchant_profile_completed_at IS NOT NULL AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)) THEN RAISE EXCEPTION 'NOT_A_MERCHANT' USING ERRCODE='P0001'; END IF;
  FOR v_c IN SELECT lc.* FROM public.library_cards lc JOIN public.auction_items ai ON ai.library_card_id=lc.id WHERE ai.auction_id=p_old_auction_id ORDER BY lc.id FOR UPDATE LOOP NULL; END LOOP;
  FOR v_i IN SELECT * FROM public.auction_items WHERE auction_id=p_old_auction_id ORDER BY id LOOP
    v_reason:=NULL; v_name:=v_i.card_name;
    SELECT * INTO v_c FROM public.library_cards WHERE id=v_i.library_card_id FOR UPDATE;
    IF NOT FOUND OR v_c.user_id<>p_seller_id THEN v_reason:='missing';
    ELSIF v_c.quantity<v_i.quantity THEN v_reason:='insufficient_quantity';
    ELSIF NOT EXISTS(SELECT 1 FROM public.card_photos WHERE library_card_id=v_c.id) THEN v_reason:='photo_required';
    ELSIF EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE library_card_id=v_c.id AND NOT (source_kind='auction' AND source_id=p_old_auction_id)) THEN v_reason:='already_listed'; END IF;
    IF v_reason IS NOT NULL THEN v_bad:=v_bad||jsonb_build_array(jsonb_build_object('library_card_id',v_i.library_card_id,'card_name',v_name,'requested_quantity',v_i.quantity,'owned_quantity',coalesce(v_c.quantity,0),'reason',v_reason)); END IF;
  END LOOP;
  IF jsonb_array_length(v_bad)>0 THEN RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE='P0001',DETAIL=v_bad::text; END IF;
  -- A stale old-auction reservation can only occur when a sweep was interrupted;
  -- relisting replaces it transactionally with the new source reservation.
  DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=p_old_auction_id;
  v_exp:=now()+make_interval(hours=>p_duration_hours);
  INSERT INTO public.auctions(seller_id,title,status,starting_bid_myr,buyout_myr,bid_increment,duration_hours,published_at,expires_at,original_expires_at,soft_close_enabled,relisted_from_auction_id)
  VALUES(v_old.seller_id,v_old.title,'active',v_old.starting_bid_myr,v_old.buyout_myr,v_old.bid_increment,p_duration_hours,now(),v_exp,v_exp,v_old.soft_close_enabled,p_old_auction_id) RETURNING id INTO v_new;
  FOR v_i IN SELECT * FROM public.auction_items WHERE auction_id=p_old_auction_id ORDER BY library_card_id LOOP
    SELECT * INTO v_c FROM public.library_cards WHERE id=v_i.library_card_id;
    INSERT INTO public.auction_items(auction_id,library_card_id,quantity,scryfall_id,card_name,set_code,set_name,collector_number,finish,condition,language,allocation_weight_myr)
    SELECT v_new,v_c.id,v_i.quantity,v_c.scryfall_id::text,ci.name,ci.set_code,ci.set_name,ci.collector_number,v_c.foil,v_c.condition,v_c.language,NULL
    FROM public.card_index ci WHERE ci.scryfall_id=v_c.scryfall_id;
    INSERT INTO public.marketplace_card_reservations(library_card_id,owner_id,source_kind,source_id,reserved_quantity) VALUES(v_c.id,p_seller_id,'auction',v_new,v_i.quantity);
  END LOOP;
  RETURN v_new;
END $$;

-- §4.6 — Bulk expiry sweep and unclaimed-win demotion.
CREATE OR REPLACE FUNCTION public.settle_expired_auctions(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.auctions%ROWTYPE; v_n integer:=0; v_winner uuid;
BEGIN
  IF p_limit IS NULL OR p_limit<1 THEN RAISE EXCEPTION 'INVALID_LIMIT' USING ERRCODE='P0001'; END IF;
  FOR v IN SELECT * FROM public.auctions WHERE status='active' AND expires_at<=p_now ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    IF v.bid_count=0 THEN UPDATE public.auctions SET status='expired' WHERE id=v.id; DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=v.id;
    ELSE SELECT bidder_id INTO v_winner FROM public.auction_bids WHERE auction_id=v.id ORDER BY amount_myr DESC,created_at ASC,id ASC LIMIT 1; UPDATE public.auctions SET status='ended_pending_winner',winner_id=v_winner,won_at=v.expires_at WHERE id=v.id; END IF; v_n:=v_n+1;
  END LOOP;
  -- Accepted W1 design warning: one invocation applies p_limit independently
  -- to active expiry and unclaimed-win demotion batches.
  FOR v IN SELECT * FROM public.auctions WHERE status='ended_pending_winner' AND won_at+interval '24 hours'<=p_now ORDER BY won_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.auctions SET status='relist_available' WHERE id=v.id; DELETE FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=v.id; v_n:=v_n+1;
  END LOOP;
  RETURN v_n;
END $$;

-- §4.9 — Existing order state machine extended for auction completion/cancellation.
CREATE OR REPLACE FUNCTION public.transition_order(p_order_id uuid,p_actor_id uuid,p_action text,p_reason text DEFAULT NULL)
RETURNS public.orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_order public.orders%ROWTYPE; v_from text; v_item public.order_items%ROWTYPE; v_aid uuid;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id=p_order_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0001'; END IF; v_from:=v_order.status;
  IF p_action='preparing_order' AND p_actor_id=v_order.seller_id AND v_from='awaiting_payment' THEN UPDATE public.orders SET status='preparing_order',preparing_order_at=now(),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action='payment_received' AND p_actor_id=v_order.seller_id AND v_from='preparing_order' THEN UPDATE public.orders SET status='payment_received',payment_received_at=now(),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action='dropped_off' AND p_actor_id=v_order.seller_id AND v_from='payment_received' THEN UPDATE public.orders SET status='dropped_off',dropped_off_at=now(),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
  ELSIF p_action='order_completed' AND p_actor_id=v_order.buyer_id AND v_from='dropped_off' THEN
    UPDATE public.orders SET status='order_completed',completed_at=now(),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
    -- Release every order reservation before touching inventory.  The FK is
    -- non-deferrable, so exact-quantity card deletes must come second.
    DELETE FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=p_order_id;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id=p_order_id LOOP
      IF v_item.library_card_id IS NOT NULL THEN UPDATE public.library_cards SET quantity=quantity-v_item.quantity WHERE id=v_item.library_card_id AND quantity>v_item.quantity; IF NOT FOUND THEN DELETE FROM public.library_cards WHERE id=v_item.library_card_id AND quantity=v_item.quantity; END IF; END IF;
    END LOOP;
  ELSIF p_action='cancel' AND p_actor_id=v_order.seller_id AND v_from NOT IN ('order_completed','cancelled') THEN
    IF p_reason IS NULL OR char_length(btrim(p_reason))<5 OR char_length(p_reason)>500 THEN RAISE EXCEPTION 'Cancellation reason must be 5 to 500 characters' USING ERRCODE='22023'; END IF;
    UPDATE public.orders SET status='cancelled',cancelled_at=now(),cancelled_by=p_actor_id,cancellation_reason=btrim(p_reason),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
    DELETE FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=p_order_id;
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id=p_order_id LOOP
      IF v_item.price_source IN ('auction_bid','auction_buyout') THEN
        IF v_item.auction_id IS NOT NULL THEN UPDATE public.auctions SET status='relist_available' WHERE id=v_item.auction_id AND status='ended_sold'; END IF;
      ELSE
        IF v_item.listing_id IS NULL THEN RAISE EXCEPTION 'Reserved listing cannot be restored' USING ERRCODE='P0001'; END IF;
        UPDATE public.listings SET quantity=quantity+v_item.quantity,status=CASE WHEN expires_at>now() AND EXISTS (
          SELECT 1 FROM public.profiles p WHERE p.id=listings.user_id AND p.merchant_profile_completed_at IS NOT NULL
            AND nullif(btrim(p.merchant_bank_name),'') IS NOT NULL
            AND nullif(btrim(p.merchant_account_name),'') IS NOT NULL
            AND (nullif(btrim(p.merchant_account_number),'') IS NOT NULL OR nullif(btrim(p.merchant_duitnow_id),'') IS NOT NULL)
        ) THEN 'active' ELSE 'expired' END WHERE id=v_item.listing_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Reserved listing cannot be restored' USING ERRCODE='P0001'; END IF;
      END IF;
    END LOOP;
    UPDATE public.order_cancellation_requests SET resolved_at=now(),resolved_by=p_actor_id,resolution='accepted' WHERE order_id=p_order_id AND resolved_at IS NULL;
  ELSE RAISE EXCEPTION 'Actor is not authorized for this order transition' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.order_events(order_id,actor_id,event_type,from_status,to_status,reason) VALUES(p_order_id,p_actor_id,p_action,v_from,v_order.status,nullif(btrim(p_reason),'')); RETURN v_order;
END $$;

-- Service-role-only execution boundary for every Phase 45B RPC.
REVOKE ALL ON FUNCTION public.create_auction_draft(uuid,text,integer,text,integer,integer,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.update_auction_draft(uuid,uuid,text,integer,text,integer,integer,boolean,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.add_auction_draft_item(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.remove_auction_draft_item(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.update_auction_draft_item(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.publish_auction(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.place_auction_bid(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.checkout_auction_buyout(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.checkout_auction_claim(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.extend_auction(uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.relist_auction(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_expired_auctions(integer,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.transition_order(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.phase45_allocate_auction_lines(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_auction_draft(uuid,text,integer,text,integer,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_auction_draft(uuid,uuid,text,integer,text,integer,integer,boolean,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_auction_draft_item(uuid,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_auction_draft_item(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_auction_draft_item(uuid,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_auction(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.place_auction_bid(uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkout_auction_buyout(uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkout_auction_claim(uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.extend_auction(uuid,uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.relist_auction(uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_expired_auctions(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_order(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.phase45_allocate_auction_lines(uuid,integer) TO service_role;
