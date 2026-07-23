'use client'

import BazaarCard from '@/components/BazaarCard'

// Showcase Row — displays 5 cards on desktop, 2 on mobile. Extracted from
// BazaarView (Phase 44 Pass A) so the Home page can render the same hero
// shelves without importing Bazaar's marketplace view.
export default function ShowcaseRow({ title, subtitle, listings, prices, onSelect }) {
  return (
    <section aria-labelledby={`showcase-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="mb-4">
        <h2
          id={`showcase-${title.toLowerCase().replace(/\s+/g, '-')}`}
          className="text-dbb-lg sm:text-dbb-xl font-semibold tracking-heading text-gray-900"
        >
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>
        )}
      </div>

      {/* Desktop: 5 cards in a row */}
      <div className="hidden sm:grid grid-cols-5 gap-4 lg:gap-5">
        {listings.map(listing => (
          <BazaarCard
            key={listing.id}
            listing={listing}
            variant="showcase"
            priceData={prices[`${listing.library_cards?.scryfall_id}:${listing.library_cards?.foil || 'normal'}`]}
            onClick={() => onSelect(listing)}
          />
        ))}
      </div>

      {/* Mobile: 2 cards side by side */}
      <div className="sm:hidden grid grid-cols-2 gap-3">
        {listings.map(listing => (
          <BazaarCard
            key={listing.id}
            listing={listing}
            variant="showcase"
            priceData={prices[`${listing.library_cards?.scryfall_id}:${listing.library_cards?.foil || 'normal'}`]}
            onClick={() => onSelect(listing)}
          />
        ))}
      </div>
    </section>
  )
}
