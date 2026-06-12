import axios from 'axios'

// Scryfall API client
const scryfallClient = axios.create({
  baseURL: 'https://api.scryfall.com',
  headers: {
    'User-Agent': 'DansBizarreBazaar/1.0',
    'Accept': 'application/json',
  },
  timeout: 10000,
})

// CardKingdom API client
const cardkingdomClient = axios.create({
  baseURL: 'https://api.cardkingdom.com/api/v2',
  timeout: 15000,
})

export const scryfallAPI = {
  // Search cards by name
  searchCards: async (query) => {
    try {
      const response = await scryfallClient.get('/cards/search', {
        params: { q: query }
      })
      return response.data
    } catch (error) {
      console.error('Scryfall search error:', error.message)
      throw error
    }
  },

  // Get card by Scryfall ID
  getCardById: async (scryfallId) => {
    try {
      const response = await scryfallClient.get(`/cards/${scryfallId}`)
      return response.data
    } catch (error) {
      console.error('Scryfall get card error:', error.message)
      throw error
    }
  },

  // Get card by set code and collector number
  getCardBySetNumber: async (setCode, collectorNumber) => {
    try {
      const response = await scryfallClient.get('/cards/named', {
        params: {
          set: setCode,
          number: collectorNumber,
        }
      })
      return response.data
    } catch (error) {
      console.error('Scryfall get by set/number error:', error.message)
      throw error
    }
  },

  // Extract card data for our schema
  extractCardData: (scryfallCard) => {
    if (!scryfallCard || scryfallCard.object !== 'card') {
      return null
    }

    return {
      scryfall_id: scryfallCard.id,
      card_name: scryfallCard.name,
      set_code: scryfallCard.set,
      set_name: scryfallCard.set_name,
      collector_number: scryfallCard.collector_number,
      rarity: scryfallCard.rarity || 'common',
      card_type: scryfallCard.type_line,
      colors: scryfallCard.colors || [],
      is_foil: scryfallCard.foil || false,
      image_png_url: scryfallCard.image_uris?.png || scryfallCard.card_faces?.[0]?.image_uris?.png,
      image_crop_url: scryfallCard.image_uris?.art_crop || scryfallCard.card_faces?.[0]?.image_uris?.art_crop,
    }
  },

  // Batch fetch cards (respecting rate limits)
  batchFetchCards: async (cardList, delayMs = 100) => {
    const results = []
    
    for (const card of cardList) {
      try {
        // Try to fetch by set code and collector number first
        const scryfallData = await scryfallAPI.getCardBySetNumber(
          card.set_code,
          card.collector_number
        )
        
        results.push({
          input: card,
          scryfall: scryfallAPI.extractCardData(scryfallData),
          success: true,
        })
      } catch (error) {
        // Fallback: try searching by name
        try {
          const searchResult = await scryfallAPI.searchCards(
            `!"${card.card_name}" e:${card.set_code}`
          )
          
          if (searchResult.data && searchResult.data.length > 0) {
            results.push({
              input: card,
              scryfall: scryfallAPI.extractCardData(searchResult.data[0]),
              success: true,
            })
          } else {
            results.push({
              input: card,
              error: 'Card not found',
              success: false,
            })
          }
        } catch (searchError) {
          results.push({
            input: card,
            error: searchError.message,
            success: false,
          })
        }
      }
      
      // Rate limiting delay
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
    
    return results
  },
}

export const cardkingdomAPI = {
  // Fetch the entire pricelist (cached approach recommended)
  getPricelist: async () => {
    try {
      const response = await cardkingdomClient.get('/pricelist')
      return response.data
    } catch (error) {
      console.error('CardKingdom pricelist error:', error.message)
      throw error
    }
  },

  // Build a lookup map from pricelist
  buildPriceLookup: (pricelist) => {
    const lookup = new Map()
    
    if (pricelist && Array.isArray(pricelist.products)) {
      for (const product of pricelist.products) {
        if (product.ScryfallID) {
          lookup.set(product.ScryfallID.toLowerCase(), {
            ckd_usd_price: parseFloat(product.PriceRetail) || 0,
            ckd_buy_price: parseFloat(product.PriceBuy) || 0,
            is_foil: product.IsFoil || false,
            sku: product.Sku,
          })
        }
      }
    }
    
    return lookup
  },

  // Find price for a specific card
  findPrice: (priceLookup, scryfallId, isFoil = false) => {
    if (!scryfallId) return null
    
    const key = scryfallId.toLowerCase()
    const price = priceLookup.get(key)
    
    if (price && price.is_foil === isFoil) {
      return price
    }
    
    return null
  },

  // Fetch and build price lookup (use sparingly - cache the result!)
  fetchPriceLookup: async () => {
    const pricelist = await cardkingdomAPI.getPricelist()
    return cardkingdomAPI.buildPriceLookup(pricelist)
  },
}

// Combined service for processing cards
export const cardProcessingService = {
  // Process a single card entry
  processCard: async (cardInput, priceLookup, exchangeRate = 4.70) => {
    try {
      // Fetch from Scryfall
      let scryfallData
      try {
        const scryfallResponse = await scryfallAPI.getCardBySetNumber(
          cardInput.set_code,
          cardInput.collector_number
        )
        scryfallData = scryfallAPI.extractCardData(scryfallResponse)
      } catch (error) {
        // Try name-based search as fallback
        const searchResult = await scryfallAPI.searchCards(
          `!"${cardInput.card_name}" e:${cardInput.set_code}`
        )
        if (searchResult.data && searchResult.data.length > 0) {
          scryfallData = scryfallAPI.extractCardData(searchResult.data[0])
        } else {
          throw new Error('Card not found in Scryfall')
        }
      }

      if (!scryfallData) {
        throw new Error('Failed to extract card data')
      }

      // Get pricing from CardKingdom
      const priceInfo = cardkingdomAPI.findPrice(
        priceLookup,
        scryfallData.scryfall_id,
        cardInput.is_foil || false
      )

      // Calculate MYR prices
      const ckdUsdPrice = priceInfo?.ckd_usd_price || 0
      
      return {
        ...scryfallData,
        is_foil: cardInput.is_foil || false,
        condition: cardInput.condition || 'NM',
        ckd_usd_price: ckdUsdPrice,
        ckd_buy_price: priceInfo?.ckd_buy_price || 0,
        myr_price_2_5: ckdUsdPrice > 0 ? Math.round(ckdUsdPrice * exchangeRate * 2.5 * 100) / 100 : null,
        myr_price_2_8: ckdUsdPrice > 0 ? Math.round(ckdUsdPrice * exchangeRate * 2.8 * 100) / 100 : null,
        myr_price_3_0: ckdUsdPrice > 0 ? Math.round(ckdUsdPrice * exchangeRate * 3.0 * 100) / 100 : null,
        usd_myr_rate: exchangeRate,
      }
    } catch (error) {
      console.error(`Error processing ${cardInput.card_name}:`, error.message)
      return {
        ...cardInput,
        error: error.message,
        success: false,
      }
    }
  },

  // Process multiple cards with rate limiting
  processBatch: async (cards, priceLookup, exchangeRate = 4.70, concurrency = 3) => {
    const results = []
    const queue = [...cards]
    const inProgress = []

    while (queue.length > 0 || inProgress.length > 0) {
      // Fill up to concurrency limit
      while (inProgress.length < concurrency && queue.length > 0) {
        const card = queue.shift()
        const promise = cardProcessingService
          .processCard(card, priceLookup, exchangeRate)
          .then(result => {
            results.push(result)
            const index = inProgress.indexOf(promise)
            if (index > -1) inProgress.splice(index, 1)
            return result
          })
        inProgress.push(promise)
      }

      // Wait for at least one to complete
      if (inProgress.length > 0) {
        await Promise.race(inProgress)
      }

      // Rate limiting between batches
      await new Promise(resolve => setTimeout(resolve, 150))
    }

    return results
  },
}
