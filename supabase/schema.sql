-- Dan's Bizarre Bazaar (DBB) - Supabase Schema
-- Purpose: MTG card claim sales system for Facebook group

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create DBB schema
CREATE SCHEMA IF NOT EXISTS dbb;

-- Cards table - main card inventory
CREATE TABLE dbb.cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scryfall_id UUID UNIQUE,
    card_name TEXT NOT NULL,
    set_code TEXT NOT NULL,
    set_name TEXT,
    collector_number TEXT NOT NULL,
    rarity TEXT CHECK (rarity IN ('common', 'uncommon', 'rare', 'mythic', 'special')),
    card_type TEXT,
    colors TEXT[], -- Array of color codes: W, U, B, R, G
    is_foil BOOLEAN DEFAULT FALSE,
    condition TEXT DEFAULT 'NM' CHECK (condition IN ('NM', 'LP', 'MP', 'HP', 'DMG')),
    
    -- Pricing (USD from CardKingdom)
    ckd_usd_price DECIMAL(10,2),
    ckd_buy_price DECIMAL(10,2),
    
    -- MYR pricing with multipliers
    myr_price_2_5 DECIMAL(10,2),
    myr_price_2_8 DECIMAL(10,2),
    myr_price_3_0 DECIMAL(10,2),
    
    -- Exchange rate used for calculation
    usd_myr_rate DECIMAL(10,4) DEFAULT 4.70,
    
    -- Scryfall image URLs
    image_png_url TEXT,
    image_crop_url TEXT,
    
    -- Metadata
    is_available BOOLEAN DEFAULT TRUE,
    facebook_post_id TEXT,
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX idx_cards_set_code ON dbb.cards(set_code);
CREATE INDEX idx_cards_rarity ON dbb.cards(rarity);
CREATE INDEX idx_cards_colors ON dbb.cards USING GIN(colors);
CREATE INDEX idx_cards_card_type ON dbb.cards(card_type);
CREATE INDEX idx_cards_is_foil ON dbb.cards(is_foil);
CREATE INDEX idx_cards_ckd_usd_price ON dbb.cards(ckd_usd_price);
CREATE INDEX idx_cards_available ON dbb.cards(is_available) WHERE is_available = TRUE;
CREATE INDEX idx_cards_scryfall_id ON dbb.cards(scryfall_id);

-- Price history tracking (optional, for analytics)
CREATE TABLE dbb.price_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    card_id UUID REFERENCES dbb.cards(id) ON DELETE CASCADE,
    ckd_usd_price DECIMAL(10,2),
    usd_myr_rate DECIMAL(10,4),
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_price_history_card_id ON dbb.price_history(card_id);
CREATE INDEX idx_price_history_recorded_at ON dbb.price_history(recorded_at);

-- Exchange rates table
CREATE TABLE dbb.exchange_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usd_myr_rate DECIMAL(10,4) NOT NULL,
    source TEXT DEFAULT 'manual',
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default exchange rate
INSERT INTO dbb.exchange_rates (usd_myr_rate, source) VALUES (4.70, 'default');

-- Function to calculate MYR prices automatically
CREATE OR REPLACE FUNCTION dbb.calculate_myr_prices()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ckd_usd_price IS NOT NULL AND NEW.usd_myr_rate IS NOT NULL THEN
        NEW.myr_price_2_5 := ROUND(NEW.ckd_usd_price * NEW.usd_myr_rate * 2.5, 2);
        NEW.myr_price_2_8 := ROUND(NEW.ckd_usd_price * NEW.usd_myr_rate * 2.8, 2);
        NEW.myr_price_3_0 := ROUND(NEW.ckd_usd_price * NEW.usd_myr_rate * 3.0, 2);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-calculate MYR prices
DROP TRIGGER IF EXISTS trg_calculate_myr_prices ON dbb.cards;
CREATE TRIGGER trg_calculate_myr_prices
    BEFORE INSERT OR UPDATE OF ckd_usd_price, usd_myr_rate ON dbb.cards
    FOR EACH ROW
    EXECUTE FUNCTION dbb.calculate_myr_prices();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION dbb.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trg_update_updated_at ON dbb.cards;
CREATE TRIGGER trg_update_updated_at
    BEFORE UPDATE ON dbb.cards
    FOR EACH ROW
    EXECUTE FUNCTION dbb.update_updated_at_column();

-- Row Level Security (RLS) policies
ALTER TABLE dbb.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dbb.price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE dbb.exchange_rates ENABLE ROW LEVEL SECURITY;

-- Allow public read access (for frontend)
CREATE POLICY "Allow public read access to cards" ON dbb.cards
    FOR SELECT USING (TRUE);

-- Allow authenticated users to insert/update cards
CREATE POLICY "Allow authenticated users to manage cards" ON dbb.cards
    FOR ALL USING (auth.role() = 'authenticated');

-- Allow public read access to price history
CREATE POLICY "Allow public read access to price history" ON dbb.price_history
    FOR SELECT USING (TRUE);

-- Allow authenticated users to manage price history
CREATE POLICY "Allow authenticated users to manage price history" ON dbb.price_history
    FOR ALL USING (auth.role() = 'authenticated');

-- Allow public read access to exchange rates
CREATE POLICY "Allow public read access to exchange rates" ON dbb.exchange_rates
    FOR SELECT USING (TRUE);

-- Allow authenticated users to manage exchange rates
CREATE POLICY "Allow authenticated users to manage exchange rates" ON dbb.exchange_rates
    FOR ALL USING (auth.role() = 'authenticated');

-- Create a view for available cards with formatted data
CREATE VIEW dbb.available_cards AS
SELECT 
    id,
    scryfall_id,
    card_name,
    set_code,
    set_name,
    collector_number,
    rarity,
    card_type,
    colors,
    is_foil,
    condition,
    ckd_usd_price,
    ckd_buy_price,
    myr_price_2_5,
    myr_price_2_8,
    myr_price_3_0,
    usd_myr_rate,
    image_png_url,
    image_crop_url,
    created_at,
    updated_at
FROM dbb.cards
WHERE is_available = TRUE
ORDER BY created_at DESC;

-- Grant permissions to postgres and service roles
GRANT ALL ON SCHEMA dbb TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA dbb TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA dbb TO postgres;

GRANT ALL ON SCHEMA dbb TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA dbb TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA dbb TO service_role;

-- Grant anon read access
GRANT SELECT ON dbb.cards TO anon;
GRANT SELECT ON dbb.available_cards TO anon;
GRANT SELECT ON dbb.price_history TO anon;
GRANT SELECT ON dbb.exchange_rates TO anon;

COMMENT ON SCHEMA dbb IS 'Dan''s Bizarre Bazaar - MTG card claim sales system';
COMMENT ON TABLE dbb.cards IS 'Main card inventory with pricing';
COMMENT ON TABLE dbb.price_history IS 'Historical price tracking';
COMMENT ON TABLE dbb.exchange_rates IS 'USD to MYR exchange rate history';
