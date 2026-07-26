-- DBB local-UAT seed: deterministic, synthetic, and idempotent.
-- Never run against hosted/shared production. The only credential here is the
-- documented local UAT account: dan@dbb.test / password1234.
--
-- The fixed UUIDs make reset output stable and keep fixture joins explicit.
-- No production rows, hosted URLs, project identifiers, or service keys appear.

BEGIN;

-- Supabase-supported seed pattern: seed auth.users directly so GoTrue can
-- authenticate the fixed account, using pgcrypto's bcrypt helper. The trigger
-- from migration-002 creates the matching public.profiles and default binder.
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token
)
VALUES (
  'd0000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'dan@dbb.test',
  crypt('password1234', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"username":"dan_uat","display_name":"Dan UAT"}'::jsonb,
  now(),
  now(),
  ''
)
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    encrypted_password = EXCLUDED.encrypted_password,
    email_confirmed_at = EXCLUDED.email_confirmed_at,
    raw_app_meta_data = EXCLUDED.raw_app_meta_data,
    raw_user_meta_data = EXCLUDED.raw_user_meta_data,
    updated_at = EXCLUDED.updated_at;

-- Keep the trigger-created profile/binder deterministic if a prior local run
-- left the account row but not its dependent rows.
INSERT INTO public.profiles (id, username, display_name)
VALUES (
  'd0000000-0000-4000-8000-000000000001',
  'dan_uat',
  'Dan UAT'
)
ON CONFLICT (id) DO UPDATE
SET username = EXCLUDED.username,
    display_name = EXCLUDED.display_name;

INSERT INTO public.binders (id, user_id, name, description, is_default)
VALUES (
  'd1000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'UAT Binder',
  'Deterministic synthetic Phase 45C fixture',
  false
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_default = EXCLUDED.is_default;

-- Minimal catalog rows used by authenticated library/auction API UAT.
INSERT INTO public.card_index (
  scryfall_id, name, set_code, set_name, collector_number, rarity,
  colors, type_line, cmc, mana_cost
)
VALUES
  ('d2000000-0000-4000-8000-000000000001', 'UAT Lightning Bolt', 'uat', 'UAT Synthetic Set', '1', 'common', '{}', 'Instant', 1, '{R}'),
  ('d2000000-0000-4000-8000-000000000002', 'UAT Counterspell', 'uat', 'UAT Synthetic Set', '2', 'uncommon', '{U}', 'Instant', 2, '{U}{U}')
ON CONFLICT (scryfall_id) DO UPDATE
SET name = EXCLUDED.name,
    set_code = EXCLUDED.set_code,
    set_name = EXCLUDED.set_name,
    collector_number = EXCLUDED.collector_number,
    rarity = EXCLUDED.rarity,
    colors = EXCLUDED.colors,
    type_line = EXCLUDED.type_line,
    cmc = EXCLUDED.cmc,
    mana_cost = EXCLUDED.mana_cost;

INSERT INTO public.library_cards (
  id, user_id, binder_id, scryfall_id, quantity, foil, condition, language, starred
)
VALUES
  ('d3000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 4, 'normal', 'NM', 'en', true),
  ('d3000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002', 2, 'foil', 'LP', 'en', false)
ON CONFLICT (id) DO UPDATE
SET quantity = EXCLUDED.quantity,
    foil = EXCLUDED.foil,
    condition = EXCLUDED.condition,
    language = EXCLUDED.language,
    starred = EXCLUDED.starred;

-- A versioned synthetic condition photo exercises Phase 40's contract without
-- creating a storage object or copying any production media.
INSERT INTO public.card_photos (id, user_id, library_card_id, storage_path)
VALUES (
  'd4000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001/d3000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000001.jpg'
)
ON CONFLICT (library_card_id) DO UPDATE
SET storage_path = EXCLUDED.storage_path,
    user_id = EXCLUDED.user_id;

COMMIT;
