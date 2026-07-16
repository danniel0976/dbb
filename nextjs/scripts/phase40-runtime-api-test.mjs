import assert from 'node:assert/strict'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'

const appUrl = process.env.PHASE40_APP_URL
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceUrl = process.env.PHASE40_SERVICE_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const email = process.env.PHASE40_TEST_EMAIL
const password = process.env.PHASE40_TEST_PASSWORD
const libraryCardId = process.env.PHASE40_LIBRARY_CARD_ID
const disposableStack = process.env.PHASE40_DISPOSABLE_STACK

for (const [name, value] of Object.entries({
  PHASE40_APP_URL: appUrl,
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  PHASE40_SERVICE_SUPABASE_URL: serviceUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  PHASE40_TEST_EMAIL: email,
  PHASE40_TEST_PASSWORD: password,
  PHASE40_LIBRARY_CARD_ID: libraryCardId,
  PHASE40_DISPOSABLE_STACK: disposableStack,
})) {
  if (!value) throw new Error(`Missing ${name}`)
}

function isLoopbackUrl(value) {
  const hostname = new URL(value).hostname
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function isDisposableAuthUrl(value) {
  const url = new URL(value)
  return isLoopbackUrl(value) || url.origin === 'https://dans-macbook-air.tail9b7cc9.ts.net:8444'
}

if (disposableStack !== 'phase40-device-stack' || !isLoopbackUrl(appUrl) || !isLoopbackUrl(serviceUrl) || !isDisposableAuthUrl(supabaseUrl) || !email.endsWith('@dbb.test')) {
  throw new Error('Refusing to run outside the disposable local Phase 40 stack')
}

const cookieJar = new Map()
const auth = createServerClient(supabaseUrl, anonKey, {
  cookies: {
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
    setAll: cookies => cookies.forEach(({ name, value }) => cookieJar.set(name, value)),
  },
})
const service = createServiceClient(serviceUrl, serviceKey)

const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({ email, password })
assert.ifError(signInError)
assert.ok(signIn.user?.id, 'test login did not return a user')

const cookieHeader = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ')
assert.ok(cookieHeader, 'test login did not produce SSR cookies')

async function exportRequest(body) {
  const response = await fetch(`${appUrl}/api/facebook-export/${libraryCardId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function prepare() {
  const { response, data } = await exportRequest({ action: 'prepare', multiplier: 2.8 })
  assert.equal(response.status, 200, `prepare failed: ${JSON.stringify(data)}`)
  assert.equal(data.preparation?.ckd_usd, 10)
  assert.equal(data.preparation?.myr_price, 28)
  assert.equal(data.preparation?.condition, 'NM')
  assert.equal(data.preparation?.finish, 'normal')
  assert.ok(data.preparation?.preparation_token)
  assert.ok(data.preparation?.photo_storage_path)

  const photo = await fetch(data.preparation.photo_url)
  assert.equal(photo.status, 200, 'prepared photo URL did not resolve')
  assert.match(photo.headers.get('content-type') || '', /^image\//)
  assert.ok((await photo.arrayBuffer()).byteLength > 0, 'prepared photo was empty')
  return data.preparation
}

const { data: originalCard, error: originalCardError } = await service
  .from('library_cards')
  .select('condition, user_id')
  .eq('id', libraryCardId)
  .single()
assert.ifError(originalCardError)
assert.equal(signIn.user.id, originalCard.user_id, 'auth and service URLs do not point to the same disposable fixture')

const { data: originalSnapshot, error: originalSnapshotError } = await service
  .from('fb_export_snapshots')
  .select('*')
  .eq('library_card_id', libraryCardId)
  .maybeSingle()
assert.ifError(originalSnapshotError)

let testError = null
try {
  assert.equal(originalCard.condition, 'NM', 'disposable fixture must begin at NM')
  const first = await prepare()

  const tamperedToken = `${first.preparation_token.slice(0, -1)}${first.preparation_token.endsWith('a') ? 'b' : 'a'}`
  const tampered = await exportRequest({ action: 'commit', preparation_token: tamperedToken })
  assert.equal(tampered.response.status, 400, 'tampered preparation token was accepted')

  const { error: driftError } = await service
    .from('library_cards')
    .update({ condition: 'LP' })
    .eq('id', libraryCardId)
  assert.ifError(driftError)

  const stale = await exportRequest({ action: 'commit', preparation_token: first.preparation_token })
  assert.equal(stale.response.status, 409, `stale preparation did not return 409: ${JSON.stringify(stale.data)}`)
  assert.equal(stale.data.code, 'EXPORT_PREPARATION_STALE')
  assert.equal(stale.data.current?.condition, 'LP')
  assert.ok(stale.data.current?.preparation_token, '409 did not provide refreshed inputs')

  const { error: restoreError } = await service
    .from('library_cards')
    .update({ condition: 'NM' })
    .eq('id', libraryCardId)
  assert.ifError(restoreError)

  const fresh = await prepare()
  const committed = await exportRequest({ action: 'commit', preparation_token: fresh.preparation_token })
  assert.equal(committed.response.status, 200, `commit failed: ${JSON.stringify(committed.data)}`)
  assert.equal(committed.data.snapshot?.generation_id, fresh.generation_id)
  assert.equal(Number(committed.data.snapshot?.ckd_usd_snapshot), fresh.ckd_usd)
  assert.equal(Number(committed.data.snapshot?.myr_price_snapshot), fresh.myr_price)
  assert.equal(committed.data.snapshot?.photo_storage_path, fresh.photo_storage_path)

  const sideEffectTables = ['listings', 'claim_sales', 'cart_items', 'orders']
  for (const table of sideEffectTables) {
    const { count, error } = await service.from(table).select('*', { count: 'exact', head: true })
    assert.ifError(error)
    assert.equal(count, 0, `${table} changed during Facebook export`)
  }

  const { count: snapshotCount, error: snapshotCountError } = await service
    .from('fb_export_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('library_card_id', libraryCardId)
  assert.ifError(snapshotCountError)
  assert.equal(snapshotCount, 1, 'successful commit did not produce exactly one snapshot')
} catch (error) {
  testError = error
} finally {
  const cleanupErrors = []
  const { error: restoreCardError } = await service
    .from('library_cards')
    .update({ condition: originalCard.condition })
    .eq('id', libraryCardId)
  if (restoreCardError) cleanupErrors.push(restoreCardError)

  const { error: clearSnapshotError } = await service
    .from('fb_export_snapshots')
    .delete()
    .eq('library_card_id', libraryCardId)
  if (clearSnapshotError) cleanupErrors.push(clearSnapshotError)

  if (originalSnapshot) {
    const { error: restoreSnapshotError } = await service
      .from('fb_export_snapshots')
      .insert(originalSnapshot)
    if (restoreSnapshotError) cleanupErrors.push(restoreSnapshotError)
  }

  if (cleanupErrors.length) {
    throw new AggregateError(testError ? [testError, ...cleanupErrors] : cleanupErrors, 'Phase 40 test cleanup failed')
  }
  if (testError) throw testError
}

console.log('Phase 40 runtime API checks passed')
