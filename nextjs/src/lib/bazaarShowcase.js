const RARE_RARITIES = new Set(['rare', 'mythic'])

function isRare(listing) {
  return RARE_RARITIES.has(listing.library_cards?.card_index?.rarity)
}

function isFoil(listing) {
  const finish = listing.library_cards?.foil
  return finish === 'foil' || finish === 'etched'
}

// Fresh arrivals is always the first page-sized slice in current order. The
// remainder is partitioned deterministically: rare foils stay with Rare,
// ordinary foils go to Foil, and everything else goes to More to discover.
export function buildShowcaseShelves(listings = []) {
  const groups = {
    'fresh-arrivals': [],
    'rare-finds': [],
    'foil-spotlight': [],
    'more-to-discover': [],
  }

  groups['fresh-arrivals'] = listings.slice(0, 12)
  for (const listing of listings.slice(12)) {
    if (isRare(listing)) groups['rare-finds'].push(listing)
    else if (isFoil(listing)) groups['foil-spotlight'].push(listing)
    else groups['more-to-discover'].push(listing)
  }

  const copy = {
    'fresh-arrivals': ['Fresh arrivals', 'New to the Bazaar', 'Recently listed singles, ready for a closer look.'],
    'rare-finds': ['Collector shelf', 'Rare finds', 'Rare and mythic cards surfaced from the current listings.'],
    'foil-spotlight': ['Light play', 'Foil spotlight', 'Foil and etched finishes from across the Bazaar.'],
    'more-to-discover': ['Keep exploring', 'More to discover', 'More cards from the current Bazaar listings.'],
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
