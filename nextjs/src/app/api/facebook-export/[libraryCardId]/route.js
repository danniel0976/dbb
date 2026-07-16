import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/lib/supabaseServer'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { ensurePriceCache, lookupPrice, sellPrice } from '@/lib/pricingCache'

export const runtime = 'nodejs'

const MULTIPLIERS = new Set([2.5, 2.8, 3.0])

function makeServiceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
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

export async function GET(_request, { params }) {
  const { libraryCardId } = await params
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
  const context = await ownerContext(libraryCardId)
  if (context.error) return context.error

  const body = await request.json().catch(() => ({}))
  const multiplier = Number(body.multiplier)
  const generationId = body.generation_id
  if (!MULTIPLIERS.has(multiplier)) {
    return NextResponse.json({ error: 'multiplier must be 2.5, 2.8 or 3.0' }, { status: 400 })
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generationId || '')) {
    return NextResponse.json({ error: 'Invalid generation ID' }, { status: 400 })
  }

  const photo = Array.isArray(context.card.card_photos) ? context.card.card_photos[0] : context.card.card_photos
  if (!photo?.storage_path) return NextResponse.json({ error: 'A condition photo is required' }, { status: 422 })

  try {
    await ensurePriceCache()
  } catch (error) {
    console.error('[Facebook export] price cache:', error.message)
    return NextResponse.json({ error: 'Price data unavailable' }, { status: 503 })
  }

  const ckdUsd = lookupPrice(context.card.scryfall_id, context.card.foil)
  const myrPrice = sellPrice(ckdUsd, multiplier)
  if (ckdUsd == null || myrPrice == null) {
    return NextResponse.json({ error: 'CardKingdom price unavailable for this finish' }, { status: 422 })
  }

  const { data, error } = await context.sc
    .rpc('save_fb_export_snapshot', {
      p_user_id: context.user.id,
      p_library_card_id: libraryCardId,
      p_multiplier: multiplier,
      p_ckd_usd: ckdUsd,
      p_myr_price: myrPrice,
      p_generation_id: generationId,
      p_photo_storage_path: photo.storage_path,
      p_condition: context.card.condition,
      p_foil: context.card.foil,
    })

  if (error) {
    console.error('[Facebook export] snapshot upsert:', error.message)
    return NextResponse.json({ error: 'Could not remember generated image' }, { status: 500 })
  }

  return NextResponse.json({
    snapshot: data,
    card: {
      name: context.card.card_index?.name,
      set_code: context.card.card_index?.set_code,
      collector_number: context.card.card_index?.collector_number,
      condition: context.card.condition,
      foil: context.card.foil,
    },
  })
}
