// Claim Sale browse thumbnails resolve only from stored card_index.image_uris.
// Local/synthetic fixture scryfall_ids have no Scryfall record, so a client-side
// Scryfall lookup is not a valid fallback for a browse tile — the stored URI is
// the single source. Shared by /api/claim-sales (Bazaar browse) and the
// dedicated /claim-sales page so both resolve the same thumbnail.

export function pickStoredImageUri(imageUris) {
  if (!imageUris || typeof imageUris !== 'object') return null
  return imageUris.art_crop || imageUris.normal || imageUris.small || null
}

// rows: active listings shaped as
//   { id, claim_sale_id, library_cards: { card_index: { image_uris } } }
// The caller is responsible for filtering to status='active' listings; card
// counts and thumbnail fallbacks both describe the currently offered children.
export function indexClaimSaleListings(rows) {
  const listingImage = {}
  const listingSale = {}
  const firstImageListing = {}
  const cardCount = {}
  for (const row of rows || []) {
    if (!row?.id || !row?.claim_sale_id) continue
    cardCount[row.claim_sale_id] = (cardCount[row.claim_sale_id] || 0) + 1
    listingSale[row.id] = row.claim_sale_id
    const uri = pickStoredImageUri(row.library_cards?.card_index?.image_uris)
    listingImage[row.id] = uri
    if (uri && firstImageListing[row.claim_sale_id] === undefined) {
      firstImageListing[row.claim_sale_id] = row.id
    }
  }
  return { listingImage, listingSale, firstImageListing, cardCount }
}

// The seller's featured listing wins while it is still an active child of this
// sale with a stored image; otherwise fall back to the first active child that
// has one, so an active sale with any imaged card still shows a thumbnail.
export function resolveFeaturedImageUri(index, claimSaleId, featuredListingId) {
  if (!index || !claimSaleId) return null
  if (featuredListingId && index.listingSale[featuredListingId] === claimSaleId) {
    const featured = index.listingImage[featuredListingId]
    if (featured) return featured
  }
  const fallbackId = index.firstImageListing[claimSaleId]
  return fallbackId ? index.listingImage[fallbackId] || null : null
}
