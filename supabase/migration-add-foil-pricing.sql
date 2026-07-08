-- DBB Schema Migration: Add foil pricing and pricing source columns
-- Run this on Supabase SQL Editor

-- Add ckd_foil_price column (CardKingdom foil retail price)
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS ckd_foil_price DECIMAL(10,2);

-- Add pricing_source column to track where price data comes from
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS pricing_source TEXT DEFAULT 'unknown';

-- Add pricing_last_updated column to track when prices were fetched
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS pricing_last_updated TIMESTAMPTZ;

-- Update the MYR calculation trigger to include foil prices
CREATE OR REPLACE FUNCTION public.calculate_myr_prices()
RETURNS TRIGGER AS $$
BEGIN
    -- Regular price MYR calculations
    IF NEW.ckd_usd_price IS NOT NULL AND NEW.usd_myr_rate IS NOT NULL THEN
        NEW.myr_price_2_5 := ROUND(NEW.ckd_usd_price * NEW.usd_myr_rate * 2.5, 2);
        NEW.myr_price_2_8 := ROUND(NEW.ckd_usd_price * NEW.usd_myr_rate * 2.8, 2);
        NEW.myr_price_3_0 := ROUND(NEW.ckd_usd_price * NEW.usd_myr_rate * 3.0, 2);
    END IF;

    -- Foil price MYR calculations (stored only if foil)
    -- Note: Foil MYR prices are calculated on the fly by the API,
    -- but we can add columns later if needed for filtering
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Make sure the trigger exists on public.cards
DROP TRIGGER IF EXISTS trg_calculate_myr_prices ON public.cards;
CREATE TRIGGER trg_calculate_myr_prices
    BEFORE INSERT OR UPDATE OF ckd_usd_price, usd_myr_rate ON public.cards
    FOR EACH ROW
    EXECUTE FUNCTION public.calculate_myr_prices();

-- Update the updated_at trigger for public.cards
DROP TRIGGER IF EXISTS trg_update_updated_at ON public.cards;
CREATE TRIGGER trg_update_updated_at
    BEFORE UPDATE ON public.cards
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Create the update_updated_at_column function if it doesn't exist in public schema
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add index for pricing_source lookups
CREATE INDEX IF NOT EXISTS idx_cards_pricing_source ON public.cards(pricing_source);
CREATE INDEX IF NOT EXISTS idx_cards_pricing_last_updated ON public.cards(pricing_last_updated);