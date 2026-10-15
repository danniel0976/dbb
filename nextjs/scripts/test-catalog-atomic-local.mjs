import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const projectRoot = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const envOutput = execFileSync('supabase', ['status', '--workdir', projectRoot, '-o', 'env'], { encoding: 'utf8' })
const env = {}
for (const line of envOutput.split(/\r?\n/)) {
  const index = line.indexOf('=')
  if (index === -1) continue
  env[line.slice(0, index)] = line.slice(index + 1).replace(/^"|"$/g, '')
}

const baseUrl = env.API_URL
const serviceKey = env.SERVICE_ROLE_KEY
const anonKey = env.ANON_KEY
if (!baseUrl || !serviceKey || !anonKey) {
  throw new Error('local Supabase status did not expose API_URL, SERVICE_ROLE_KEY, and ANON_KEY')
}

async function request(key, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { response, body }
}

function publishPayload(refreshId, rowCount, skippedCount) {
  return JSON.stringify({
    p_refresh_id: refreshId,
    p_source_field: 'test',
    p_source_url_sha256: 'test-hash',
    p_row_count: rowCount,
    p_skipped_count: skippedCount,
  })
}

const forbidden = await request(anonKey, '/rest/v1/rpc/publish_catalog_refresh', {
  method: 'POST',
  body: publishPayload(randomUUID(), 100000, 9000),
})
assert(
  forbidden.response.status === 401 || forbidden.response.status === 403,
  `anon publish must be denied, got ${forbidden.response.status}: ${JSON.stringify(forbidden.body)}`
)

const truncatedRefreshId = randomUUID()
const truncatedCardId = 'd5000000-0000-4000-8000-000000000001'
const stagedTruncated = await request(serviceKey, '/rest/v1/catalog_refresh_staging', {
  method: 'POST',
  headers: { Prefer: 'return=minimal' },
  body: JSON.stringify([{
    refresh_id: truncatedRefreshId,
    scryfall_id: truncatedCardId,
    name: 'Truncated Atomic UAT Card',
    set_code: 'uatx',
    set_name: 'Atomic UAT Set',
    collector_number: '1',
    rarity: 'rare',
    colors: ['R'],
    type_line: 'Creature',
    cmc: 1,
    mana_cost: '{R}',
    image_uris: null,
    finishes: ['nonfoil'],
  }]),
})
assert.equal(stagedTruncated.response.status, 201, JSON.stringify(stagedTruncated.body))

const truncatedPublish = await request(serviceKey, '/rest/v1/rpc/publish_catalog_refresh', {
  method: 'POST',
  body: publishPayload(truncatedRefreshId, 1, 0),
})
assert.equal(truncatedPublish.response.status, 400, JSON.stringify(truncatedPublish.body))
assert.match(String(truncatedPublish.body?.message || truncatedPublish.body), /at least 100000 accepted rows/)

const failedRows = await request(
  serviceKey,
  `/rest/v1/catalog_refresh_staging?refresh_id=eq.${truncatedRefreshId}&select=refresh_id`
)
assert.equal(failedRows.response.status, 200)
assert.equal(failedRows.body.length, 1)
const cleaned = await request(
  serviceKey,
  `/rest/v1/catalog_refresh_staging?refresh_id=eq.${truncatedRefreshId}`,
  { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
)
assert.equal(cleaned.response.status, 204, JSON.stringify(cleaned.body))

const refreshId = randomUUID()
const cardId = 'd5000000-0000-4000-8000-000000000002'
const sql = `
INSERT INTO public.catalog_refresh_staging (
  refresh_id, scryfall_id, name, set_code, set_name, collector_number,
  rarity, colors, type_line, cmc, mana_cost, image_uris, finishes
)
SELECT
  '${refreshId}'::uuid,
  CASE WHEN n = 1 THEN '${cardId}'::uuid ELSE md5('${refreshId}' || n::text)::uuid END,
  'Atomic UAT Card ' || n,
  'uatx', 'Atomic UAT Set', n::text, 'rare', ARRAY['R'], 'Creature', 1,
  '{R}', NULL, ARRAY['nonfoil']
FROM generate_series(1, 100000) AS rows(n);
`
execFileSync(
  'docker',
  ['exec', '-i', 'supabase_db_dbb-uat', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
  { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
)

const published = await request(serviceKey, '/rest/v1/rpc/publish_catalog_refresh', {
  method: 'POST',
  body: publishPayload(refreshId, 100000, 9000),
})
assert.equal(published.response.status, 200, JSON.stringify(published.body))

const current = await request(
  serviceKey,
  `/rest/v1/card_index?scryfall_id=eq.${cardId}&select=name,catalog_current`
)
assert.equal(current.response.status, 200)
assert.deepEqual(current.body, [{ name: 'Atomic UAT Card 1', catalog_current: true }])

const state = await request(
  serviceKey,
  '/rest/v1/catalog_state?id=eq.true&select=current_version,row_count,skipped_count,source_field'
)
assert.equal(state.response.status, 200)
assert.equal(state.body.length, 1)
assert.equal(state.body[0].current_version, refreshId)
assert.equal(state.body[0].row_count, 100000)
assert.equal(state.body[0].skipped_count, 9000)
assert.equal(state.body[0].source_field, 'test')

execFileSync(
  'supabase',
  ['db', 'reset', '--workdir', projectRoot, '--yes'],
  { encoding: 'utf8', stdio: 'ignore' }
)

console.log('CATALOG_ATOMIC_PASS')
