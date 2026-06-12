import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: {
    schema: 'dbb'
  }
})

// Card queries
export const cardQueries = {
  // Get all available cards with filters
  getAvailableCards: async (filters = {}) => {
    let query = supabase
      .from('available_cards')
      .select('*')
    
    // Apply filters
    if (filters.setCode) {
      query = query.eq('set_code', filters.setCode)
    }
    if (filters.rarity) {
      query = query.eq('rarity', filters.rarity)
    }
    if (filters.colors && filters.colors.length > 0) {
      query = query.contains('colors', filters.colors)
    }
    if (filters.cardType) {
      query = query.ilike('card_type', `%${filters.cardType}%`)
    }
    if (filters.isFoil !== undefined) {
      query = query.eq('is_foil', filters.isFoil)
    }
    if (filters.minPrice) {
      query = query.gte('myr_price_2_8', filters.minPrice)
    }
    if (filters.maxPrice) {
      query = query.lte('myr_price_2_8', filters.maxPrice)
    }
    
    return await query.order('created_at', { ascending: false })
  },

  // Get distinct filter values
  getFilterOptions: async () => {
    const [sets, rarities, types] = await Promise.all([
      supabase.from('available_cards').select('set_code,set_name').then(r => r.data),
      supabase.from('available_cards').select('rarity').then(r => r.data),
      supabase.from('available_cards').select('card_type').then(r => r.data),
    ])

    return {
      sets: [...new Map(sets?.map(s => [s.set_code, { code: s.set_code, name: s.set_name }]) || [])].map(([_, v]) => v),
      rarities: [...new Set(rarities?.map(r => r.rarity).filter(Boolean)) || []],
      cardTypes: [...new Set(types?.map(t => t.card_type).filter(Boolean)) || []],
    }
  },

  // Get single card by ID
  getCardById: async (id) => {
    return await supabase
      .from('available_cards')
      .select('*')
      .eq('id', id)
      .single()
  },
}

// Price utilities
export const priceUtils = {
  // Calculate MYR price from USD
  calculateMYR: (usdPrice, multiplier, exchangeRate = 4.70) => {
    return Math.round(usdPrice * exchangeRate * multiplier * 100) / 100
  },

  // Format price for display
  formatMYR: (price) => {
    if (price === null || price === undefined) return 'N/A'
    return `RM ${price.toFixed(2)}`
  },

  formatUSD: (price) => {
    if (price === null || price === undefined) return 'N/A'
    return `$${price.toFixed(2)}`
  },
}

// Generate Facebook caption
export const generateCaption = (card, multiplier = 2.8) => {
  const prices = {
    '2.5': card.myr_price_2_5,
    '2.8': card.myr_price_2_8,
    '3.0': card.myr_price_3_0,
  }

  const selectedPrice = prices[multiplier.toString()] || card.myr_price_2_8

  return `${card.card_name}
${card.rarity === 'mythic' ? 'M' : card.rarity === 'rare' ? 'R' : card.rarity === 'uncommon' ? 'U' : 'C'} ${card.collector_number.padStart(4, '0')}
${card.set_code}
CKD: ${priceUtils.formatUSD(card.ckd_usd_price)}
CKD 2.5 / 2.8 / 3.0: RM ${card.myr_price_2_5?.toFixed(2)} / RM ${card.myr_price_2_8?.toFixed(2)} / RM ${card.myr_price_3_0?.toFixed(2)}
Your price (${multiplier}x): ${priceUtils.formatMYR(selectedPrice)}
${card.is_foil ? '✨ FOIL ✨' : ''}`
}
