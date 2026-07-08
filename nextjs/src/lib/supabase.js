import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Scryfall API for images
export const scryfallAPI = {
  getCardImages: async (setCode, collectorNumber) => {
    try {
      const response = await fetch(
        `/api/scryfall?set=${encodeURIComponent(setCode)}&cn=${encodeURIComponent(collectorNumber)}`
      )
      if (!response.ok) return null
      return await response.json()
    } catch (error) {
      console.error('Scryfall API error:', error)
      return null
    }
  },
}

// ============================================================================
// Price enrichment via /api/pricing (now uses real CardKingdom prices)
// ============================================================================

const priceCache = new Map()
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL = 200 // ms between pricing requests

export const enrichCardWithPricing = async (card) => {
  if (!card.scryfall_id) return card

  const cacheKey = card.scryfall_id.toLowerCase()

  // Check cache first
  if (priceCache.has(cacheKey)) {
    const cached = priceCache.get(cacheKey)
    return { ...card, ...cached }
  }

  // Rate limit
  const now = Date.now()
  const timeSinceLastRequest = now - lastRequestTime
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest))
  }
  lastRequestTime = Date.now()

  try {
    const response = await fetch(
      `/api/pricing?scryfallId=${encodeURIComponent(card.scryfall_id)}&name=${encodeURIComponent(card.card_name || '')}`
    )

    if (!response.ok) {
      console.error(`Pricing API error for ${card.card_name}: ${response.status}`)
      return card
    }

    const pricing = await response.json()

    if (pricing) {
      // The API returns nulls for cards without CK prices (no Scryfall fallback)
      // Selling prices are CKD × multiplier — no separate exchange rate
      const enrichedData = {
        // CardKingdom USD prices (null if not available)
        ckd_usd_price: pricing.ckd_usd_price ?? null,
        ckd_foil_price: pricing.ckd_foil_price ?? null,
        ckd_buy_price: pricing.ckd_buy_price ?? null,
        // Selling prices: CKD × multiplier (no FX conversion)
        myr_price_2_5: pricing.myr_price_2_5 ?? null,
        myr_price_2_8: pricing.myr_price_2_8 ?? null,
        myr_price_3_0: pricing.myr_price_3_0 ?? null,
        // Foil selling prices
        myr_foil_price_2_5: pricing.myr_foil_price_2_5 ?? null,
        myr_foil_price_2_8: pricing.myr_foil_price_2_8 ?? null,
        myr_foil_price_3_0: pricing.myr_foil_price_3_0 ?? null,
        // Source tracking
        pricing_source: pricing.source ?? null,
        pricing_last_updated: pricing.lastUpdated ?? null,
      }

      priceCache.set(cacheKey, enrichedData)
      return { ...card, ...enrichedData }
    }
  } catch (error) {
    console.error(`Failed to fetch pricing for ${card.card_name}:`, error)
  }

  return card
}

// ============================================================================
// Card image enrichment
// ============================================================================

const imageCache = new Map()

export const enrichCardsWithImages = async (cards) => {
  const cardsWithoutImages = cards.filter(c => !c.image_crop_url && !c.image_png_url)

  if (cardsWithoutImages.length === 0) return cards

  const enrichedCards = [...cards]

  const fetchPromises = cardsWithoutImages.map(async (card) => {
    const cacheKey = `${card.set_code}_${card.collector_number}`

    if (imageCache.has(cacheKey)) {
      return { id: card.id, images: imageCache.get(cacheKey) }
    }

    try {
      const images = await scryfallAPI.getCardImages(card.set_code, card.collector_number)
      if (images && !images.error) {
        imageCache.set(cacheKey, images)
        return { id: card.id, images }
      }
    } catch (error) {
      console.error(`Failed to fetch image for ${card.card_name}:`, error)
    }

    return { id: card.id, images: null }
  })

  const results = await Promise.all(fetchPromises)

  results.forEach(({ id, images }) => {
    if (images) {
      const index = enrichedCards.findIndex(c => c.id === id)
      if (index >= 0) {
        enrichedCards[index] = { ...enrichedCards[index], ...images }
      }
    }
  })

  return enrichedCards
}

// ============================================================================
// Card queries
// ============================================================================

export const cardQueries = {
  getAvailableCards: async (filters = {}, page = 1, pageSize = 24) => {
    const start = (page - 1) * pageSize
    const end = start + pageSize - 1

    let query = supabase
      .from('cards')
      .select('id, card_name, set_code, set_name, collector_number, rarity, card_type, colors, is_foil, condition, ckd_usd_price, myr_price_2_5, myr_price_2_8, myr_price_3_0, image_png_url, image_crop_url, created_at')
      .eq('is_available', true)

    if (filters.setCode) query = query.eq('set_code', filters.setCode)
    if (filters.rarity) query = query.eq('rarity', filters.rarity)
    if (filters.colors && filters.colors.length > 0) query = query.contains('colors', filters.colors)
    if (filters.cardType) query = query.ilike('card_type', `%${filters.cardType}%`)
    if (filters.isFoil !== undefined) query = query.eq('is_foil', filters.isFoil)
    if (filters.minPrice) query = query.gte('myr_price_2_8', filters.minPrice)
    if (filters.maxPrice) query = query.lte('myr_price_2_8', filters.maxPrice)

    const result = await query
      .order('created_at', { ascending: false })
      .range(start, end)

    if (result.data && result.data.length > 0) {
      result.data = await enrichCardsWithImages(result.data)
    }

    return result
  },

  getFilterOptions: async () => {
    const [sets, rarities, types] = await Promise.all([
      supabase.from('cards').select('set_code,set_name').eq('is_available', true).then(r => r.data || []),
      supabase.from('cards').select('rarity').eq('is_available', true).then(r => r.data || []),
      supabase.from('cards').select('card_type').eq('is_available', true).then(r => r.data || []),
    ])

    return {
      sets: [...new Map(sets.map(s => [s.set_code, { code: s.set_code, name: s.set_name }]))].map(([_, v]) => v),
      rarities: [...new Set(rarities.map(r => r.rarity).filter(Boolean))],
      cardTypes: [...new Set(types.map(t => t.card_type).filter(Boolean))],
    }
  },

  getCardById: async (id) => {
    const result = await supabase.from('cards').select('*').eq('id', id).single()

    if (result.data) {
      // Fetch image if missing
      if (!result.data.image_crop_url && !result.data.image_png_url) {
        const images = await scryfallAPI.getCardImages(result.data.set_code, result.data.collector_number)
        if (images) result.data = { ...result.data, ...images }
      }

      // Fetch live pricing from CardKingdom via MTGJSON
      result.data = await enrichCardWithPricing(result.data)
    }

    return result
  },
}

// ============================================================================
// Price utilities & caption generator
// ============================================================================

export const priceUtils = {
  sellPrice: (ckdPrice, multiplier) => {
    if (ckdPrice === null || ckdPrice === undefined) return null
    return Math.round(ckdPrice * multiplier * 100) / 100
  },
  formatMYR: (price) => price === null || price === undefined ? 'N/A' : `RM ${price.toFixed(2)}`,
  formatUSD: (price) => price === null || price === undefined ? 'N/A' : `$${price.toFixed(2)}`,
}

export const generateCaption = (card, multiplier = 2.8) => {
  const prices = { '2.5': card.myr_price_2_5, '2.8': card.myr_price_2_8, '3.0': card.myr_price_3_0 }
  const selectedPrice = prices[multiplier.toString()] || card.myr_price_2_8
  const raritySymbol = { mythic: 'M', rare: 'R', uncommon: 'U', common: 'C' }[card.rarity] || 'C'

  const hasPrice = card.ckd_usd_price !== null && card.ckd_usd_price !== undefined
  const sourceLabel = hasPrice ? 'CKD' : 'N/A'

  return `${card.card_name}
${raritySymbol} ${card.collector_number?.padStart(4, '0') ?? '????'}
${card.set_code}
${sourceLabel}: ${priceUtils.formatUSD(card.ckd_usd_price)}
${sourceLabel} 2.5×/2.8×/3.0×: ${priceUtils.formatMYR(card.myr_price_2_5)} / ${priceUtils.formatMYR(card.myr_price_2_8)} / ${priceUtils.formatMYR(card.myr_price_3_0)}
Your price (${multiplier}×): ${priceUtils.formatMYR(selectedPrice)}
${card.is_foil ? '✨ FOIL ✨' : ''}`
}