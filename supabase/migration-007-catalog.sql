-- Migration 007: extend card_index with image_uris + finishes for full catalog support
-- Apply in Supabase SQL Editor (project mnyhpwqskzadkplnhbrx)

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
