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
