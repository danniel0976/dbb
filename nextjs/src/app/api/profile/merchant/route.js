import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { getMerchantProfileState } from '@/lib/merchantProfile'

export const runtime = 'nodejs'

const BUCKET = 'merchant-payment-qr'
const SIGNED_URL_TTL = 300
const QR_KINDS = {
  bank_qr: 'merchant_bank_qr_path',
  tng_qr: 'merchant_tng_qr_path',
}

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

function clean(value, max) {
  if (value == null) return null
  if (typeof value !== 'string') return undefined
  return value.trim().slice(0, max) || null
}

async function authenticate() {
  const authClient = await createAuthClient()
  const { data: { user }, error } = await authClient.auth.getUser()
  return { authClient, user: error ? null : user }
}

async function signQr(sc, path) {
  if (!path) return null
  const { data } = await sc.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL)
  return data?.signedUrl || null
}

export async function GET() {
  const { authClient, user } = await authenticate()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const state = await getMerchantProfileState(authClient, user.id)
  if (state.unavailable) {
    return NextResponse.json({ error: state.error, code: 'MERCHANT_PROFILE_UNAVAILABLE' }, { status: 503 })
  }
  if (state.error) return NextResponse.json({ error: state.error }, { status: 500 })

  const sc = makeServiceClient()
  const [bankQrUrl, tngQrUrl] = await Promise.all([
    signQr(sc, state.profile?.merchant_bank_qr_path),
    signQr(sc, state.profile?.merchant_tng_qr_path),
  ])

  return NextResponse.json({
    complete: state.complete,
    profile: {
      bank_name: state.profile?.merchant_bank_name || '',
      account_name: state.profile?.merchant_account_name || '',
      account_number: state.profile?.merchant_account_number || '',
      duitnow_id: state.profile?.merchant_duitnow_id || '',
      payment_instructions: state.profile?.merchant_payment_instructions || '',
      bank_qr_path: state.profile?.merchant_bank_qr_path || null,
      tng_qr_path: state.profile?.merchant_tng_qr_path || null,
      bank_qr_url: bankQrUrl,
      tng_qr_url: tngQrUrl,
      completed_at: state.profile?.merchant_profile_completed_at || null,
    },
  })
}

// PATCH stores self-declared permanent payment instructions. QR paths are accepted
// only when they match the caller's fixed private-storage object names.
export async function PATCH(request) {
  const { authClient, user } = await authenticate()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const fields = {
    merchant_bank_name: clean(body.bank_name, 80),
    merchant_account_name: clean(body.account_name, 100),
    merchant_account_number: clean(body.account_number, 80),
    merchant_duitnow_id: clean(body.duitnow_id, 120),
    merchant_payment_instructions: clean(body.payment_instructions, 500),
  }
  if (Object.values(fields).some(value => value === undefined)) {
    return NextResponse.json({ error: 'Seller payment fields must be strings' }, { status: 400 })
  }
  if (!fields.merchant_bank_name || !fields.merchant_account_name ||
      (!fields.merchant_account_number && !fields.merchant_duitnow_id)) {
    return NextResponse.json({
      error: 'Bank name, account name, and either an account number or DuitNow ID are required',
      code: 'MERCHANT_PROFILE_INCOMPLETE',
    }, { status: 422 })
  }

  for (const kind of Object.keys(QR_KINDS)) {
    const bodyKey = `${kind}_path`
    if (bodyKey in body) {
      const expected = body[bodyKey] == null ? null : `${user.id}/${kind}.jpg`
      if (body[bodyKey] !== expected) {
        return NextResponse.json({ error: `Invalid ${kind} storage path` }, { status: 400 })
      }
      fields[QR_KINDS[kind]] = expected
    }
  }
  fields.merchant_profile_completed_at = new Date().toISOString()
  fields.updated_at = new Date().toISOString()

  const { error } = await authClient.from('profiles').update(fields).eq('id', user.id)
  if (error) {
    const status = error.code === '42703' ? 503 : 500
    return NextResponse.json({ error: status === 503 ? 'Seller payment information is not configured yet' : error.message }, { status })
  }
  return NextResponse.json({ success: true, complete: true })
}

// POST { kind: 'bank_qr' | 'tng_qr' } creates a short-lived direct upload URL.
export async function POST(request) {
  const { user } = await authenticate()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!QR_KINDS[body.kind]) return NextResponse.json({ error: 'Invalid QR kind' }, { status: 400 })

  const storagePath = `${user.id}/${body.kind}.jpg`
  const sc = makeServiceClient()
  const { data, error } = await sc.storage.from(BUCKET).createSignedUploadUrl(storagePath)
  if (error || !data?.signedUrl) {
    const unavailable = error?.message?.includes('Bucket not found') || error?.statusCode === 404
    return NextResponse.json({ error: unavailable ? 'Merchant QR storage is not configured yet' : 'Could not create QR upload URL' }, { status: unavailable ? 503 : 500 })
  }
  return NextResponse.json({ upload_url: data.signedUrl, storage_path: storagePath, kind: body.kind })
}

export async function DELETE(request) {
  const { authClient, user } = await authenticate()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(request.url)
  const kind = searchParams.get('kind')
  const column = QR_KINDS[kind]
  if (!column) return NextResponse.json({ error: 'Invalid QR kind' }, { status: 400 })

  const path = `${user.id}/${kind}.jpg`
  const sc = makeServiceClient()
  await sc.storage.from(BUCKET).remove([path])
  const { error } = await authClient.from('profiles').update({ [column]: null, updated_at: new Date().toISOString() }).eq('id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
