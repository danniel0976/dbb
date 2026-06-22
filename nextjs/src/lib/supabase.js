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

// MTGJSON API for pricing (includes CardKingdom data)
export const mtgjsonAPI = {
  getCardPricing: async (scryfallId) => {
    if (!scryfallId) return null
    
    try {
      const response = await fetch(
        `/api/pricing?scryfallId=${encodeURIComponent(scryfallId)}`
      )
      if (!response.ok) return null
      return await response.json()
    } catch (error) {
      console.error('MTGJSON pricing error:', error)
      return null
    }
  },
}

// Enrich cards with images and pricing
const imageCache = new Map()
const priceCache = new Map()
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL = 400

export const enrichCardsWithImages = async (cards) => {
  const cardsWithoutImages = cards.filter(c => !c.image_crop_url && !c.image_png_url)
  
  if (cardsWithoutImages.length === 0) return cards
  
  const enrichedCards = [...cards]
  const cacheKeyMap = new Map() // Map card id to cache key
  
  // Prepare all fetch promises for parallel execution
  const fetchPromises = cardsWithoutImages.map(async (card) => {
    const cacheKey = `${card.set_code}_${card.collector_number}`
    cacheKeyMap.set(card.id, cacheKey)
    
    // Check cache first
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
  
  // Wait for all fetches to complete (parallel!)
  const results = await Promise.all(fetchPromises)
  
  // Apply results to enriched cards
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

// Enrich single card with pricing (for detail view)
export const enrichCardWithPricing = async (card) => {
  if (!card.scryfall_id) return card
  
  const cacheKey = card.scryfall_id.toLowerCase()
  
  if (priceCache.has(cacheKey)) {
    const pricing = priceCache.get(cacheKey)
    return { ...card, ...pricing }
  }
  
  try {
    const pricing = await mtgjsonAPI.getCardPricing(card.scryfall_id)
    
    if (pricing && !pricing.error) {
      priceCache.set(cacheKey, pricing)
      return { ...card, ...pricing }
    }
  } catch (error) {
    console.error(`Failed to fetch pricing for ${card.card_name}:`, error)
  }
  
  return card
}

// Card queries
export const cardQueries = {
  getAvailableCards: async (filters = {}, page = 1, pageSize = 24) => {
    const start = (page - 1) * pageSize
    const end = start + pageSize - 1
    
    // Select only fields you actually display (faster than *)
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
    
    // Order by created_at DESC for infinite scroll (newest first)
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
      
      // Fetch pricing from MTGJSON
      result.data = await enrichCardWithPricing(result.data)
    }
    
    return result
  },
}

// Price utilities
export const priceUtils = {
  calculateMYR: (usdPrice, multiplier, exchangeRate = 4.70) => {
    return Math.round(usdPrice * exchangeRate * multiplier * 100) / 100
  },
  formatMYR: (price) => price === null || price === undefined ? 'N/A' : `RM ${price.toFixed(2)}`,
  formatUSD: (price) => price === null || price === undefined ? 'N/A' : `$${price.toFixed(2)}`,
}

export const generateCaption = (card, multiplier = 2.8) => {
  const prices = { '2.5': card.myr_price_2_5, '2.8': card.myr_price_2_8, '3.0': card.myr_price_3_0 }
  const selectedPrice = prices[multiplier.toString()] || card.myr_price_2_8
  const raritySymbol = { mythic: 'M', rare: 'R', uncommon: 'U', common: 'C' }[card.rarity] || 'C'

  return `${card.card_name}
${raritySymbol} ${card.collector_number.padStart(4, '0')}
${card.set_code}
CKD: ${priceUtils.formatUSD(card.ckd_usd_price)}
CKD 2.5 / 2.8 / 3.0: RM ${card.myr_price_2_5?.toFixed(2) || 'N/A'} / RM ${card.myr_price_2_8?.toFixed(2) || 'N/A'} / RM ${card.myr_price_3_0?.toFixed(2) || 'N/A'}
Your price (${multiplier}x): ${priceUtils.formatMYR(selectedPrice)}
${card.is_foil ? '✨ FOIL ✨' : ''}`
}
