'use client'

import { useState, useEffect } from 'react'
import ShowcaseRow from '@/components/ShowcaseRow'
import BazaarDetailModal from '@/components/BazaarDetailModal'
import { useToast } from '@/components/Toast'
import { notifyCartChanged } from '@/lib/cartBadge.mjs'

export default function HomeView({ hotListings = [], latestListings = [], userId }) {
  const [selectedListing, setSelectedListing] = useState(null)
  const [prices, setPrices] = useState({})
  const { toast } = useToast()

  // One price request for both hero rows, mirroring BazaarView's batching.
  useEffect(() => {
    const listings = [...hotListings, ...latestListings]
    const items = [...new Map(listings
      .filter(l => l.library_cards?.scryfall_id)
      .map(l => {
        const foil = l.library_cards.foil || 'normal'
        return [`${l.library_cards.scryfall_id}:${foil}`, { scryfall_id: l.library_cards.scryfall_id, foil }]
      })).values()]
    if (!items.length) {
      setPrices({})
      return
    }
    const controller = new AbortController()
    fetch('/api/pricing/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
      signal: controller.signal,
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.prices) setPrices(data.prices) })
      .catch(err => { if (err?.name !== 'AbortError') setPrices({}) })
    return () => controller.abort()
  }, [hotListings, latestListings])

  const handleSelectListing = async (listing) => {
    if (!userId) {
      toast('Sign in to add items to your cart', 'info')
      return
    }
    try {
      const res = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listing_id: listing.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 403) {
          toast('Cannot add your own listing to cart', 'error')
        } else if (res.status === 409) {
          toast('Listing is no longer available', 'error')
        } else {
          toast(data?.error || 'Failed to add to cart', 'error')
        }
        return
      }
      if (data?.already) {
        toast('Already in your cart', 'info')
      } else {
        toast('Added to cart!', 'success')
      }
      notifyCartChanged()
    } catch {
      toast('Failed to add to cart', 'error')
    }
  }

  const hasShowcase = hotListings.length > 0 || latestListings.length > 0

  return (
    <div className="container mx-auto px-4 pb-8">
      <div className="pt-6 pb-3">
        <h1 className="text-dbb-xl sm:text-dbb-2xl font-bold tracking-heading text-gray-900">Home</h1>
      </div>

      {hasShowcase ? (
        <section className="space-y-8 sm:space-y-10 mt-6" data-home-showcase>
          {hotListings.length > 0 && (
            <ShowcaseRow
              title="Hot Selling"
              subtitle="Most popular cards by seller count"
              listings={hotListings}
              prices={prices}
              onSelect={setSelectedListing}
            />
          )}

          {latestListings.length > 0 && (
            <ShowcaseRow
              title="Latest"
              subtitle="Newest arrivals to the Bazaar"
              listings={latestListings}
              prices={prices}
              onSelect={setSelectedListing}
            />
          )}
        </section>
      ) : (
        <div className="text-center py-16">
          <h2 className="text-xl font-semibold mb-2">No cards on the bazaar yet</h2>
          <p className="text-gray-500 mb-4">List yours from your library to get started.</p>
          <a href="/library" className="btn btn-primary btn-md inline-block">
            Go to your library →
          </a>
        </div>
      )}

      {selectedListing && (
        <BazaarDetailModal
          listing={selectedListing}
          onClose={() => setSelectedListing(null)}
          onSelectListing={handleSelectListing}
          userId={userId}
        />
      )}
    </div>
  )
}
