// Shared hero-listings source for the Home showcase — Hot Selling (by
// seller_count) and Latest (by created_at). Extracted from bazaar/page.js
// (Phase 44 Pass A) so Home can fetch the same shelves without Bazaar
// needing to know about them anymore.

// Fetch top 5 for each row (desktop shows 5, mobile shows 2)
const HERO_COUNT = 5

export async function getHeroListings(sc) {
  let hotListings = []
  let latestListings = []

  // Latest listings - straightforward by created_at desc
  const { data: latestData, error: latestError } = await sc
    .from('listings')
    .select(`
      id, user_id, multiplier, status, created_at,
      library_cards!inner(
        id, scryfall_id, foil, condition, quantity,
        card_index!inner(
          name, set_code, set_name, collector_number, rarity, type_line, colors, cmc, image_uris
        )
      )
    `, { count: 'exact' })
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(HERO_COUNT)

  if (!latestError && latestData) {
    // Count sellers for each card in latest
    const scryfallIds = [...new Set(latestData.map(l => l.library_cards?.scryfall_id).filter(Boolean))]
    const sellersByCard = new Map()
    if (scryfallIds.length > 0) {
      const { data: sellerRows } = await sc
        .from('listings')
        .select('user_id, library_cards!inner(scryfall_id)')
        .eq('status', 'active')
        .in('library_cards.scryfall_id', scryfallIds)
      for (const row of sellerRows || []) {
        const id = row.library_cards?.scryfall_id
        if (!id) continue
        if (!sellersByCard.has(id)) sellersByCard.set(id, new Set())
        sellersByCard.get(id).add(row.user_id)
      }
    }
    latestListings = latestData.map(l => ({
      ...l,
      seller_count: sellersByCard.get(l.library_cards?.scryfall_id)?.size || 1,
    }))
  }

  // Hot Selling - need to aggregate seller counts across all listings per card
  // Then sort by that count. This requires a two-step approach.
  const { data: allActiveListings, error: allError } = await sc
    .from('listings')
    .select(`
      id, user_id, multiplier, status, created_at,
      library_cards(
        id, scryfall_id, foil, condition, quantity,
        card_index(name, set_code, set_name, collector_number, rarity, type_line, colors, cmc, image_uris)
      )
    `)
    .eq('status', 'active')

  if (!allError && allActiveListings) {
    // Group by scryfall_id and count unique sellers
    const cardMap = new Map()
    for (const listing of allActiveListings) {
      const scryfallId = listing.library_cards?.scryfall_id
      if (!scryfallId) continue
      if (!cardMap.has(scryfallId)) {
        cardMap.set(scryfallId, {
          listing, // keep first listing as representative
          sellers: new Set([listing.user_id]),
        })
      } else {
        cardMap.get(scryfallId).sellers.add(listing.user_id)
      }
    }
    // Convert to array with seller_count
    const cardsWithCount = Array.from(cardMap.values()).map(({ listing, sellers }) => ({
      ...listing,
      seller_count: sellers.size,
    }))
    // Sort by seller_count desc, then by created_at desc for tie-break
    cardsWithCount.sort((a, b) => {
      if (b.seller_count !== a.seller_count) return b.seller_count - a.seller_count
      return new Date(b.created_at) - new Date(a.created_at)
    })
    hotListings = cardsWithCount.slice(0, HERO_COUNT)
  }

  return { hotListings, latestListings }
}
