const RARE_RARITIES = new Set(['rare', 'mythic'])

function isRare(listing) {
  return RARE_RARITIES.has(listing.library_cards?.card_index?.rarity)
}

function isFoil(listing) {
  const finish = listing.library_cards?.foil
  return finish === 'foil' || finish === 'etched'
}

// Every listing belongs to exactly one shelf. The priority is intentional:
// rare foils live on the collector shelf, while ordinary foils live on the
// foil shelf; all remaining listings stay on the arrivals shelf.
export function buildShowcaseShelves(listings = []) {
  const groups = {
    'fresh-arrivals': [],
    'rare-finds': [],
    'foil-spotlight': [],
  }

  for (const listing of listings) {
    if (isRare(listing)) groups['rare-finds'].push(listing)
    else if (isFoil(listing)) groups['foil-spotlight'].push(listing)
    else groups['fresh-arrivals'].push(listing)
  }

  const copy = {
    'fresh-arrivals': ['Fresh arrivals', 'New to the Bazaar', 'Recently listed singles, ready for a closer look.'],
    'rare-finds': ['Collector shelf', 'Rare finds', 'Rare and mythic cards surfaced from the current listings.'],
    'foil-spotlight': ['Light play', 'Foil spotlight', 'Foil and etched finishes from across the Bazaar.'],
  }

  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => ({
      key,
      eyebrow: copy[key][0],
      title: copy[key][1],
      description: copy[key][2],
      items,
    }))
}

export function canCommitBazaarRequest(requestGeneration, currentGeneration) {
  return requestGeneration === currentGeneration
}
