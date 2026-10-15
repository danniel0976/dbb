import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const root = new URL('../../', import.meta.url)
const read = name => readFileSync(new URL(name, root), 'utf8')
const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const migrationName = '20261015000000_private_writer_rpc_execute.sql'
const migration = strip(read(`supabase/migrations/${migrationName}`))
const tests = strip(read('supabase/tests/rpc_execute_privileges.sql'))
const schema = strip(read('supabase/tests/uat_schema_gate.sql'))
const writers = [
  'import_library_cards(uuid,uuid,jsonb)', 'move_library_cards(uuid,uuid,uuid[])',
  'promote_card_photo(uuid,uuid,text)', 'delete_card_photo_and_invalidate_export(uuid,uuid)',
  'update_library_card_and_invalidate_export(uuid,uuid,jsonb)',
  'save_fb_export_snapshot(uuid,uuid,numeric,numeric,numeric,uuid,text,text,text)',
]
const triggers = ['enforce_listing_merchant_profile','handle_new_profile','handle_new_user',
  'phase45c_claim_sale_status_sync','phase45c_guard_card_inventory','phase45c_sync_listing_reservation','protect_reserved_listing']
for (const signature of writers) {
  assert.ok(migration.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`))
  assert.ok(migration.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`))
}
for (const name of triggers) assert.ok(migration.includes(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated;`))
assert.equal((tests.match(/\('public\.[^']+', (?:true|false)\)/g) || []).length, 44)
for (const code of [tests, schema]) {
  for (const role of ['anon','authenticated','service_role']) assert.ok(code.includes(`has_function_privilege('${role}'`))
  assert.ok(code.includes('aclexplode(') && code.includes('prosecdef'))
}
const versions = readdirSync(new URL('supabase/migrations/', root)).map(name => name.slice(0, 14)).sort()
const expected = [...schema.matchAll(/\('(\d{14})'\)/g)].map(match => match[1]).sort()
assert.deepEqual(expected, versions)
assert.ok(schema.includes(`<> ${versions.length} THEN`))
// The forward function differs from immutable baseline only by the authorized guard.
const baseline = read('supabase/migrations/20260101000000_dbb_baseline.sql')
const oldBody = baseline.match(/create or replace function public\.move_library_cards\([\s\S]*?as \$\$([\s\S]*?)end \$\$;/i)[1]
const newBody = migration.match(/AS \$function\$([\s\S]*?)end \$function\$;/i)[1]
const guard = /  if not exists \(\s+select 1 from public\.binders\s+where id = p_target_binder_id and user_id = p_user_id\s+\) then\s+raise exception '[^']+'\s+using errcode = '42501';\s+end if;\n/i
assert.ok(guard.test(newBody))
assert.equal(newBody.replace(guard, '').trim(), oldBody.trim())
assert.ok(migration.indexOf('CREATE OR REPLACE FUNCTION') < migration.indexOf('REVOKE ALL'))
assert.ok(tests.includes('EXCEPTION WHEN insufficient_privilege'))
console.log('RPC_EXECUTE_STATIC_PASS: exact ACLs, all44 inventory, ledger parity, guard-only function delta')

if (process.argv.includes('--local-runtime')) {
  const container = process.env.PHASE45C_DB_CONTAINER || 'supabase_db_dbb-uat'
  assert.ok(/^supabase_db_[a-zA-Z0-9_-]+$/.test(container), 'local Supabase container only')
  const result = spawnSync('docker', ['exec','-i',container,'psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],
    { input: read('supabase/tests/rpc_execute_privileges.sql'), encoding: 'utf8', timeout: 60000 })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  assert.ifError(result.error)
  assert.equal(result.status, 0, 'local RPC privilege SQL failed')
}
