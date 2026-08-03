#!/usr/bin/env node

// Reproduce the upgrade order that a clean reset cannot cover: an already
// hardened Phase 45C transition_order is overwritten by the historical 45B
// Auction body, then restored by the forward reconciliation migration.  The
// function bodies are extracted directly from their tracked migration sources,
// so this test cannot accidentally exercise a hand-copied approximation.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url)
const CURRENT_PATH = new URL('supabase/migrations/20260726000000_phase45c_cart_hardening.sql', ROOT)
const HISTORICAL_PATH = new URL('supabase/migrations/20260724000001_phase45_auctions_rpcs.sql', ROOT)
const RECONCILIATION_PATH = new URL('supabase/migrations/20260803000001_phase45c_transition_order_reconciliation.sql', ROOT)
const DB_CONTAINER = process.env.PHASE45C_DB_CONTAINER || 'supabase_db_dbb-uat'
const args = process.argv.slice(2)
const LOCAL_RUNTIME = args.includes('--local-runtime')

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

expect(
  args.every(arg => arg === '--local-runtime'),
  'use --local-runtime to run the Docker-backed upgrade-path sequence; the default is self-contained static verification',
)

function transitionBody(path) {
  const source = readFileSync(path, 'utf8')
  const matches = source.match(/CREATE OR REPLACE FUNCTION public\.transition_order\([\s\S]*?END \$\$;/g) || []
  expect(matches.length === 1, `expected exactly one transition_order body in ${path.pathname}, found ${matches.length}`)
  return matches[0]
}

const current = transitionBody(CURRENT_PATH)
const historical = transitionBody(HISTORICAL_PATH)
const reconciliation = transitionBody(RECONCILIATION_PATH)

const requiredHardened = [
  'ORDER_NOT_AUTHORIZED',
  'ORDER BY l.id',
  'ORDER BY lc.id',
  'ORDER BY m.library_card_id, m.source_id',
  'WHERE id = p_order_id FOR UPDATE',
  'LISTING_CARD_OWNER_MISMATCH',
  'phase45c_claim_sale_eligible',
  'ORDER_NOT_FOUND',
  'LISTING_NOT_FOUND',
  'INVALID_CANCELLATION_REASON',
  'ORDER_TRANSITION_NOT_ALLOWED',
]
const requiredAuction = ['auction_bid', 'auction_buyout', 'relist_available', "status='ended_sold'"]

for (const token of [...requiredHardened, ...requiredAuction]) {
  expect(current.includes(token), `current Phase 45C body is missing ${token}`)
  expect(reconciliation.includes(token), `reconciliation body is missing ${token}`)
}
expect(!historical.includes('ORDER_NOT_AUTHORIZED'), 'historical Phase 45B body unexpectedly contains hardened authorization')
expect(historical.includes('auction_bid') && historical.includes('auction_buyout'), 'historical Phase 45B body lacks Auction cancellation branches')
expect(
  reconciliation.indexOf('ORDER_NOT_AUTHORIZED') < reconciliation.indexOf("v_from = 'order_completed'"),
  'reconciliation places terminal authorization after terminal replay',
)

if (!LOCAL_RUNTIME) {
  console.log(JSON.stringify({ result: 'PHASE45C_TRANSITION_ORDER_UPGRADE_STATIC_PASS', sources: 3 }))
  process.exit(0)
}

const runtimeAssertions = `
DO $$
DECLARE src text;
BEGIN
  src := regexp_replace(pg_get_functiondef('public.transition_order(uuid,uuid,text,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  IF src !~ 'ORDER_NOT_AUTHORIZED'
    OR src !~ 'ORDER BY l.id'
    OR src !~ 'ORDER BY lc.id'
    OR src !~ 'ORDER BY m.library_card_id, m.source_id'
    OR src !~ 'WHERE id = p_order_id FOR UPDATE'
    OR src !~ 'LISTING_CARD_OWNER_MISMATCH'
    OR src !~ 'phase45c_claim_sale_eligible'
    OR src !~ 'ORDER_NOT_FOUND'
    OR src !~ 'LISTING_NOT_FOUND'
    OR src !~ 'INVALID_CANCELLATION_REASON'
    OR src !~ 'ORDER_TRANSITION_NOT_ALLOWED'
    OR src !~ 'auction_bid'
    OR src !~ 'auction_buyout'
    OR src !~ 'relist_available' THEN
    RAISE EXCEPTION 'PHASE45C_TRANSITION_RECONCILIATION_INCOMPLETE';
  END IF;
  IF strpos(src, 'ORDER_NOT_AUTHORIZED') > strpos(src, 'v_from = ''order_completed''') THEN
    RAISE EXCEPTION 'PHASE45C_TERMINAL_AUTH_AFTER_REPLAY';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.transition_order(uuid,uuid,text,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.transition_order(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PHASE45C_TRANSITION_EXECUTION_BOUNDARY_WRONG';
  END IF;
END $$;`

const downgradeAssertion = `
DO $$
DECLARE src text;
BEGIN
  src := pg_get_functiondef('public.transition_order(uuid,uuid,text,text)'::regprocedure);
  IF src ~ 'ORDER_NOT_AUTHORIZED' OR src ~ 'phase45c_claim_sale_eligible'
    OR src !~ 'auction_bid' OR src !~ 'auction_buyout' THEN
    RAISE EXCEPTION 'PHASE45C_HISTORICAL_DOWNGRADE_NOT_REPRODUCED';
  END IF;
END $$;`

const sql = `BEGIN;
${current}
${runtimeAssertions}
${historical}
${downgradeAssertion}
${readFileSync(RECONCILIATION_PATH, 'utf8')}
${runtimeAssertions}
ROLLBACK;
SELECT 'PHASE45C_TRANSITION_ORDER_UPGRADE_PASS' AS result;`

const result = spawnSync('docker', [
  'exec', '-i', DB_CONTAINER, 'psql', '-q', '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', '-t', '-A',
], { input: sql, encoding: 'utf8' })

if (result.status !== 0) {
  throw new Error(`transition_order upgrade-path runtime gate failed (psql ${result.status}): ${result.stderr || result.stdout}`)
}
expect(result.stdout.includes('PHASE45C_TRANSITION_ORDER_UPGRADE_PASS'), `transition_order upgrade-path receipt missing: ${result.stdout}`)
console.log(JSON.stringify({ result: 'PHASE45C_TRANSITION_ORDER_UPGRADE_PASS', sources: 3, container: DB_CONTAINER }))
