import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { ensurePriceCache, lookupPrice, sellPrice } from '@/lib/pricingCache'

export const runtime = 'nodejs'

const BUCKET = 'card-photos'
const PREPARATION_TTL_SECONDS = 300
const MULTIPLIERS = new Set([2.5, 2.8, 3.0])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function makeServiceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every(key => allowedKeys.has(key))
}

function normalizeLabel(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function canonicalFacts(card, photoPath) {
  return {
    scryfall_id: normalizeLabel(card.scryfall_id),
    photo_storage_path: photoPath,
    card_name: normalizeLabel(card.card_index?.name, 'Magic: The Gathering card'),
    set_code: normalizeLabel(card.card_index?.set_code).toUpperCase(),
    collector_number: normalizeLabel(card.card_index?.collector_number),
    condition: normalizeLabel(card.condition),
    finish: normalizeLabel(card.foil),
  }
}

function signPreparation(preparation) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('Missing snapshot signing secret')
  const payload = Buffer.from(JSON.stringify(preparation)).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function validatePreparation(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set([
    'version', 'user_id', 'library_card_id', 'generation_id', 'photo_storage_path', 'photo_url',
    'card_name', 'set_code', 'collector_number', 'condition', 'finish', 'scryfall_id',
    'ckd_usd', 'myr_price', 'multiplier', 'prepared_at', 'expires_at',
  ]))) return false

  if (value.version !== 1 || !UUID_PATTERN.test(value.user_id || '') || !UUID_PATTERN.test(value.library_card_id || '')) return false
  if (!GENERATION_ID_PATTERN.test(value.generation_id || '') || !MULTIPLIERS.has(value.multiplier)) return false
  if (!Number.isFinite(value.ckd_usd) || value.ckd_usd < 0 || value.ckd_usd > 100000) return false
  if (!Number.isFinite(value.myr_price) || value.myr_price < 0 || value.myr_price > 1000000) return false
  if (!Number.isSafeInteger(value.prepared_at) || !Number.isSafeInteger(value.expires_at) || value.expires_at <= value.prepared_at) return false

  const boundedStrings = [
    [value.scryfall_id, 100], [value.photo_storage_path, 1000], [value.photo_url, 4096],
    [value.card_name, 500], [value.set_code, 50], [value.collector_number, 100],
    [value.condition, 100], [value.finish, 100],
  ]
  if (boundedStrings.some(([item, max]) => typeof item !== 'string' || item.length < 1 || item.length > max)) return false

  try {
    const photoUrl = new URL(value.photo_url)
    if (photoUrl.protocol !== 'https:' && photoUrl.protocol !== 'http:') return false
  } catch {
    return false
  }

  return true
}

function verifyPreparation(token) {
  if (typeof token !== 'string' || token.length < 80 || token.length > 12000) return null
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('Missing snapshot signing secret')
  const expected = createHmac('sha256', secret).update(parts[0]).digest()
  let supplied
  try {
    supplied = Buffer.from(parts[1], 'base64url')
  } catch {
    return null
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null

  let preparation
  try {
    preparation = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  return validatePreparation(preparation) ? preparation : null
}

async function ownerContext(libraryCardId) {
  const authClient = await createAuthClient()
  const { data: { user }, error } = await authClient.auth.getUser()
  if (error || !user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const sc = makeServiceClient()
  const { data: card, error: cardError } = await sc
    .from('library_cards')
    .select('id, user_id, scryfall_id, foil, condition, card_index(name, set_code, collector_number), card_photos(storage_path)')
    .eq('id', libraryCardId)
    .maybeSingle()

  if (cardError) return { error: NextResponse.json({ error: 'Could not load card' }, { status: 500 }) }
  if (!card) return { error: NextResponse.json({ error: 'Library card not found' }, { status: 404 }) }
  if (card.user_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { sc, user, card }
}

function canonicalPhoto(card) {
  return Array.isArray(card.card_photos) ? card.card_photos[0] : card.card_photos
}

async function reloadContext(context, libraryCardId) {
  const { data: card, error } = await context.sc
    .from('library_cards')
    .select('id, user_id, scryfall_id, foil, condition, card_index(name, set_code, collector_number), card_photos(storage_path)')
    .eq('id', libraryCardId)
    .eq('user_id', context.user.id)
    .maybeSingle()
  return error || !card ? null : { ...context, card }
}

async function currentPrice(card, multiplier) {
  try {
    await ensurePriceCache()
  } catch (error) {
    console.error('[Facebook export] price cache:', error.message)
    return { error: NextResponse.json({ error: 'Price data unavailable' }, { status: 503 }) }
  }

  const rawCkdUsd = lookupPrice(card.scryfall_id, card.foil)
  if (rawCkdUsd == null) {
    return { error: NextResponse.json({ error: 'CardKingdom price unavailable for this finish' }, { status: 422 }) }
  }
  const ckdUsd = Number(rawCkdUsd)
  const myrPrice = sellPrice(ckdUsd, multiplier)
  if (!Number.isFinite(ckdUsd) || !Number.isFinite(myrPrice)) {
    return { error: NextResponse.json({ error: 'CardKingdom price unavailable for this finish' }, { status: 422 }) }
  }
  return { ckdUsd, myrPrice }
}

async function createPreparation(context, libraryCardId, multiplier) {
  const photo = canonicalPhoto(context.card)
  if (!photo?.storage_path) {
    return { error: NextResponse.json({ error: 'A condition photo is required' }, { status: 422 }) }
  }

  const price = await currentPrice(context.card, multiplier)
  if (price.error) return price

  const { data: signedData, error: signError } = await context.sc.storage
    .from(BUCKET)
    .createSignedUrl(photo.storage_path, PREPARATION_TTL_SECONDS)
  if (signError || !signedData?.signedUrl) {
    console.error('[Facebook export] photo signing:', signError?.message)
    return { error: NextResponse.json({ error: 'Could not prepare condition photo' }, { status: 500 }) }
  }

  const now = Math.floor(Date.now() / 1000)
  const preparation = {
    version: 1,
    user_id: context.user.id,
    library_card_id: libraryCardId,
    generation_id: randomUUID(),
    ...canonicalFacts(context.card, photo.storage_path),
    photo_url: signedData.signedUrl,
    ckd_usd: price.ckdUsd,
    myr_price: price.myrPrice,
    multiplier,
    prepared_at: now,
    expires_at: now + PREPARATION_TTL_SECONDS,
  }

  return {
    preparation: {
      ...preparation,
      preparation_token: signPreparation(preparation),
    },
  }
}

function preparationDrift(preparation, context, libraryCardId, ckdUsd, myrPrice) {
  const photo = canonicalPhoto(context.card)
  const current = canonicalFacts(context.card, photo?.storage_path || '')
  const reasons = []

  if (preparation.user_id !== context.user.id || preparation.library_card_id !== libraryCardId) reasons.push('owner or card changed')
  if (preparation.expires_at <= Math.floor(Date.now() / 1000)) reasons.push('preparation expired')
  for (const key of ['scryfall_id', 'photo_storage_path', 'card_name', 'set_code', 'collector_number', 'condition', 'finish']) {
    if (preparation[key] !== current[key]) reasons.push(`${key} changed`)
  }
  if (Math.abs(preparation.ckd_usd - ckdUsd) > Number.EPSILON || preparation.myr_price !== myrPrice) {
    reasons.push('price changed')
  }

  return reasons
}

async function staleResponse(context, libraryCardId, multiplier, reasons) {
  const latestContext = await reloadContext(context, libraryCardId)
  const refreshed = latestContext
    ? await createPreparation(latestContext, libraryCardId, multiplier)
    : null
  return NextResponse.json({
    error: 'Card details, photo, or price changed while the image was being generated. Inputs were refreshed; generate again.',
    code: 'EXPORT_PREPARATION_STALE',
    reasons,
    current: refreshed?.preparation || null,
  }, { status: 409 })
}

export async function GET(_request, { params }) {
  const { libraryCardId } = await params
  if (!UUID_PATTERN.test(libraryCardId || '')) {
    return NextResponse.json({ error: 'Invalid library card ID' }, { status: 400 })
  }
  const context = await ownerContext(libraryCardId)
  if (context.error) return context.error

  const { data: snapshot, error } = await context.sc
    .from('fb_export_snapshots')
    .select('multiplier, ckd_usd_snapshot, myr_price_snapshot, generation_id, photo_storage_path, generated_at')
    .eq('library_card_id', libraryCardId)
    .eq('user_id', context.user.id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: 'Could not load export snapshot' }, { status: 500 })
  return NextResponse.json({ snapshot })
}

export async function POST(request, { params }) {
  const { libraryCardId } = await params
  if (!UUID_PATTERN.test(libraryCardId || '')) {
    return NextResponse.json({ error: 'Invalid library card ID' }, { status: 400 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!isPlainObject(body) || (body.action !== 'prepare' && body.action !== 'commit')) {
    return NextResponse.json({ error: 'action must be prepare or commit' }, { status: 400 })
  }

  const context = await ownerContext(libraryCardId)
  if (context.error) return context.error

  if (body.action === 'prepare') {
    if (!hasOnlyKeys(body, new Set(['action', 'multiplier'])) || typeof body.multiplier !== 'number' || !MULTIPLIERS.has(body.multiplier)) {
      return NextResponse.json({ error: 'multiplier must be 2.5, 2.8 or 3.0' }, { status: 400 })
    }
    const prepared = await createPreparation(context, libraryCardId, body.multiplier)
    return prepared.error || NextResponse.json(prepared)
  }

  if (!hasOnlyKeys(body, new Set(['action', 'preparation_token']))) {
    return NextResponse.json({ error: 'Invalid snapshot commit fields' }, { status: 400 })
  }
  const preparation = verifyPreparation(body.preparation_token)
  if (!preparation) {
    return NextResponse.json({ error: 'Invalid or tampered generation preparation' }, { status: 400 })
  }

  const price = await currentPrice(context.card, preparation.multiplier)
  if (price.error) return price.error
  const drift = preparationDrift(preparation, context, libraryCardId, price.ckdUsd, price.myrPrice)
  if (drift.length) return staleResponse(context, libraryCardId, preparation.multiplier, drift)

  const preparedValues = preparation
  const { data, error } = await context.sc.rpc('save_fb_export_snapshot', {
    p_user_id: context.user.id,
    p_library_card_id: libraryCardId,
    p_multiplier: preparedValues.multiplier,
    p_ckd_usd: preparedValues.ckd_usd,
    p_myr_price: preparedValues.myr_price,
    p_generation_id: preparedValues.generation_id,
    p_photo_storage_path: preparedValues.photo_storage_path,
    p_condition: preparedValues.condition,
    p_foil: preparedValues.finish,
  })

  if (error) {
    const message = error.message || ''
    if (message.includes('changed during generation') || message.includes('library card not found')) {
      return staleResponse(context, libraryCardId, preparedValues.multiplier, ['authoritative state changed during snapshot commit'])
    }
    console.error('[Facebook export] snapshot upsert:', message)
    return NextResponse.json({ error: 'Could not remember generated image' }, { status: 500 })
  }

  return NextResponse.json({ snapshot: data, preparation: preparedValues })
}
