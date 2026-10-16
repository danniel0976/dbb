import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import './test-library-batch-idempotency.mjs'
import './test-library-batch-idempotency-client.mjs'
const root = new URL('../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const code = source => source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const migration = code(read('supabase/migrations/20261016000000_library_batch_idempotency.sql'))
assert.match(migration, /PRIMARY KEY \(user_id, batch_id\)/)
assert.match(migration, /ALTER TABLE public\.library_batch_receipts ENABLE ROW LEVEL SECURITY/)
assert.doesNotMatch(migration, /CREATE POLICY/i)
assert.match(migration, /SECURITY DEFINER SET search_path = public/)
assert.match(migration, /REVOKE ALL ON FUNCTION public\.import_library_cards_once\(uuid,uuid,uuid,jsonb\) FROM PUBLIC, anon, authenticated/)
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.import_library_cards_once\(uuid,uuid,uuid,jsonb\) TO service_role/)
assert.match(migration, /ON CONFLICT ON CONSTRAINT library_batch_receipts_pkey DO NOTHING/)
assert.ok(migration.indexOf('IF v_claimed = 0 THEN') < migration.indexOf('FROM public.import_library_cards('))
assert.match(migration, /WHERE id=p_binder_id AND user_id=p_user_id/)
const schema = code(read('supabase/tests/uat_schema_gate.sql'))
const versions = readdirSync(new URL('supabase/migrations/', root)).filter(name => /^\d{14}_.*\.sql$/.test(name)).map(name => name.slice(0,14)).sort()
assert.deepEqual([...schema.matchAll(/\('(\d{14})'\)/g)].map(m => m[1]).sort(), versions)
assert.ok(schema.includes(`<> ${versions.length} THEN`))
for (const name of ['library_batch_receipts', 'import_library_cards_once']) assert.ok(schema.includes(name))
console.log('BATCH_IDEMPOTENCY_SOURCE_PASS: receipt transaction, service-only ACL, ownership, 16-version gate')
if (process.argv.includes('--local-runtime')) {
  const container = process.env.PHASE45C_DB_CONTAINER || 'supabase_db_dbb-train'
  assert.match(container, /^supabase_db_[a-zA-Z0-9_-]+$/)
  const r = spawnSync('docker', ['exec','-i',container,'psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'], {
    input: read('supabase/tests/library_batch_idempotency.sql'), encoding: 'utf8', timeout: 30000,
  })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')
  assert.ifError(r.error)
  assert.equal(r.status, 0)
  const race = spawnSync(process.execPath, [new URL('./test-library-batch-idempotency-concurrency.mjs', import.meta.url).pathname,'--local-runtime'], { encoding:'utf8', timeout:30000 })
  process.stdout.write(race.stdout || '')
  process.stderr.write(race.stderr || '')
  assert.ifError(race.error)
  assert.equal(race.status, 0)
}
