'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Grid, Filter, X, Search, Loader2, Layers } from 'lucide-react'
import Sidebar from '@/components/Sidebar'
import BazaarCard from '@/components/BazaarCard'
import BazaarDetailModal from '@/components/BazaarDetailModal'
import LoadingSkeleton from '@/components/LoadingSkeleton'
import ClaimSalesBrowse from '@/components/ClaimSalesBrowse'
import { useToast } from '@/components/Toast'

const INITIAL_FILTERS = {
  setCode: null,
  rarities: [],
  colors: [],
  cardType: null,
  minPrice: null,
  maxPrice: null,
  isFoil: null,
  sortBy: 'newest',
  search: '',
}

const SORT_LABELS = {
  newest: 'Newest',
  price_high: 'Price: High → Low',
  price_low: 'Price: Low → High',
  name_az: 'Name: A–Z',
  rarity: 'Rarity',
}

/** Human-readable chip labels for everything in `filters` except sort/search. */
function buildChips(filters, filterOptions) {
  const chips = []
  if (filters.setCode) {
    const set = filterOptions.sets.find(s => s.code === filters.setCode)
    chips.push({ key: 'setCode', label: set?.name || filters.setCode, clear: (f) => ({ ...f, setCode: null }) })
  }
  for (const r of filters.rarities) {
    chips.push({ key: `rarity-${r}`, label: r, clear: (f) => ({ ...f, rarities: f.rarities.filter(x => x !== r) }) })
  }
  for (const c of filters.colors) {
    chips.push({ key: `color-${c}`, label: c, clear: (f) => ({ ...f, colors: f.colors.filter(x => x !== c) }) })
  }
  if (filters.cardType) {
    chips.push({ key: 'cardType', label: filters.cardType, clear: (f) => ({ ...f, cardType: null }) })
  }
  if (filters.isFoil !== null && filters.isFoil !== undefined) {
    chips.push({ key: 'isFoil', label: filters.isFoil ? 'Foil only' : 'Non-foil only', clear: (f) => ({ ...f, isFoil: null }) })
  }
  if (filters.minPrice != null) {
    chips.push({ key: 'minPrice', label: `Min RM${filters.minPrice}`, clear: (f) => ({ ...f, minPrice: null }) })
  }
  if (filters.maxPrice != null) {
    chips.push({ key: 'maxPrice', label: `Max RM${filters.maxPrice}`, clear: (f) => ({ ...f, maxPrice: null }) })
  }
  return chips
}

export default function BazaarView({ initialData, filterOptions: initialFilterOptions, userId }) {
  const [listings, setListings] = useState(initialData?.listings || [])
  const [total, setTotal] = useState(initialData?.total || 0)
  const [hasMore, setHasMore] = useState(initialData?.hasMore || false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(!initialData)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [filters, setFilters] = useState(INITIAL_FILTERS)
  const [filterOptions] = useState(initialFilterOptions || { sets: [], rarities: [], cardTypes: [] })
  const [selectedListing, setSelectedListing] = useState(null)
  const [prices, setPrices] = useState({})
  const [bazaarSection, setBazaarSection] = useState('singles') // 'singles' | 'claim_sales'
  const { toast } = useToast()

  const PAGE_SIZE = 24
  const searchTimeout = useRef(null)

  // One price request per result set/page, instead of one request per tile.
  useEffect(() => {
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
  }, [listings])

  // Lock body scroll while the mobile filter bottom sheet is open.
  useEffect(() => {
    if (filterSheetOpen) {
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = '' }
    }
  }, [filterSheetOpen])

  const buildParams = useCallback((f = filters, p = 1) => {
    const params = new URLSearchParams({ page: String(p), sort: f.sortBy })
    if (f.search) params.set('search', f.search)
    if (f.setCode) params.set('setCode', f.setCode)
    if (f.rarities?.length) params.set('rarities', f.rarities.join(','))
    if (f.colors?.length) params.set('colors', f.colors.join(','))
    if (f.cardType) params.set('cardType', f.cardType)
    if (f.isFoil !== null && f.isFoil !== undefined) params.set('isFoil', String(f.isFoil))
    return params
  }, [filters])

  const loadListings = useCallback(async (f = filters) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/listings?${buildParams(f, 1)}`)
      if (!res.ok) throw new Error('Failed to load listings')
      const data = await res.json()
      setListings(data.listings || [])
      setTotal(data.total || 0)
      setHasMore(data.hasMore || false)
      setPage(1)
    } catch (err) {
      setError('Failed to load bazaar listings.')
    } finally {
      setLoading(false)
    }
  }, [filters, buildParams])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const nextPage = page + 1
      const res = await fetch(`/api/listings?${buildParams(filters, nextPage)}`)
      if (!res.ok) return
      const data = await res.json()
      setListings(prev => [...prev, ...(data.listings || [])])
      setPage(nextPage)
      setHasMore(data.hasMore || false)
    } catch {
      // silent
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, page, filters, buildParams])

  // Infinite scroll
  useEffect(() => {
    const sentinel = document.getElementById('bazaar-sentinel')
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting && !loadingMore && hasMore) loadMore() },
      { threshold: 0.5, rootMargin: '200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore, loadingMore, hasMore])

  const updateFilter = (key, value) => {
    const next = { ...filters, [key]: value }
    setFilters(next)
    clearTimeout(searchTimeout.current)
    if (key === 'search') {
      searchTimeout.current = setTimeout(() => loadListings(next), 300)
    } else {
      loadListings(next)
    }
  }

  const applyFilters = (next) => {
    setFilters(next)
    loadListings(next)
  }

  const clearFilters = () => {
    setFilters(INITIAL_FILTERS)
    loadListings(INITIAL_FILTERS)
  }

  const removeChip = (chip) => {
    applyFilters(chip.clear(filters))
  }

  const hasActiveFilters = Object.entries(filters).some(([key, v]) => {
    if (key === 'sortBy') return v !== 'newest'
    if (key === 'search') return v !== ''
    if (key === 'isFoil') return v !== null
    if (Array.isArray(v)) return v.length > 0
    return v !== null && v !== undefined
  })

  const chips = buildChips(filters, filterOptions)

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
    } catch {
      toast('Failed to add to cart', 'error')
    }
  }

  return (
    <div className="min-h-screen">
      {/* Page title region */}
      <div className="container mx-auto px-4 pt-6 pb-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-dbb-xl sm:text-dbb-2xl font-bold tracking-heading text-gray-900 dark:text-white">Bazaar</h1>
          {bazaarSection === 'singles' && !loading && (
            <span className="text-dbb-sm text-gray-500 dark:text-gray-400">
              {total} listing{total !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Singles / Claim Sales segmented control */}
        <div
          role="tablist"
          aria-label="Bazaar section"
          className="relative inline-flex mt-4 p-1 h-11 rounded-full bg-gray-100 dark:bg-dbb-secondary"
        >
          <div
            aria-hidden="true"
            className="absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-full bg-white dark:bg-dbb-surface-elevated shadow-dbb-sm transition-transform duration-200 ease-out"
            style={{ transform: bazaarSection === 'claim_sales' ? 'translateX(calc(100% + 8px))' : 'translateX(0)' }}
          />
          <button
            role="tab"
            aria-selected={bazaarSection === 'singles'}
            onClick={() => setBazaarSection('singles')}
            className={`relative z-10 flex items-center gap-1.5 px-4 h-full rounded-full text-sm font-medium transition-colors ${
              bazaarSection === 'singles' ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            <Grid className="w-3.5 h-3.5" />
            Singles
          </button>
          <button
            role="tab"
            aria-selected={bazaarSection === 'claim_sales'}
            onClick={() => setBazaarSection('claim_sales')}
            className={`relative z-10 flex items-center gap-1.5 px-4 h-full rounded-full text-sm font-medium transition-colors ${
              bazaarSection === 'claim_sales' ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Claim Sales
          </button>
        </div>

        {/* Search — primary control */}
        {bazaarSection === 'singles' && (
          <div className="mt-4 flex items-center gap-2">
            <div className="relative flex-1 max-w-xl">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search cards..."
                value={filters.search}
                onChange={(e) => updateFilter('search', e.target.value)}
                className="w-full h-11 sm:h-12 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-full pl-10 pr-9 text-dbb-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-500 shadow-dbb-sm"
              />
              {filters.search && (
                <button
                  onClick={() => updateFilter('search', '')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-dbb-accent transition-colors"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button
              onClick={() => setFilterSheetOpen(true)}
              className="lg:hidden flex items-center justify-center gap-1.5 h-11 px-4 rounded-full border border-gray-200 dark:border-dbb-tertiary/50 bg-white dark:bg-dbb-secondary text-sm font-medium shadow-dbb-sm active:scale-[0.97] transition-transform"
            >
              <Filter className="w-4 h-4" />
              Filters
              {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-dbb-accent" />}
            </button>
          </div>
        )}
      </div>

      {bazaarSection === 'claim_sales' ? (
        <ClaimSalesBrowse userId={userId} />
      ) : (
        <div className="container mx-auto px-4 pb-8">
          <div className="lg:flex lg:items-start lg:gap-6">
            {/* Filter panel — Desktop: contained floating panel inside the page
                flow, not pinned to the browser edge. */}
            <aside className="hidden lg:block w-64 shrink-0 sticky top-[76px] rounded-dbb-lg bg-white dark:bg-dbb-secondary shadow-dbb-sm border border-black/[0.04] dark:border-white/[0.06] max-h-[calc(100vh-96px)] overflow-y-auto">
              <Sidebar
                filters={filters}
                updateFilter={updateFilter}
                clearFilters={clearFilters}
                filterOptions={filterOptions}
              />
            </aside>

            {/* Filter bottom sheet — Mobile (replaces the left drawer) */}
            {filterSheetOpen && (
              <div className="lg:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Filters">
                <div
                  className="absolute inset-0 bg-black/50"
                  onClick={() => setFilterSheetOpen(false)}
                />
                <div className="absolute left-0 right-0 bottom-0 max-h-[85vh] rounded-t-dbb-xl dbb-glass-sheet shadow-dbb-md flex flex-col">
                  <div className="shrink-0 flex items-center justify-center pt-2 pb-1">
                    <span className="w-9 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
                  </div>
                  <div className="shrink-0 px-4 pb-3 flex items-center justify-between border-b border-black/5 dark:border-white/10">
                    <h2 className="text-dbb-lg font-semibold text-gray-900 dark:text-white">Filters</h2>
                    <button
                      onClick={() => setFilterSheetOpen(false)}
                      className="p-2 -mr-2 hover:bg-black/5 dark:hover:bg-white/10 rounded-full"
                      aria-label="Close filters"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    <Sidebar
                      filters={filters}
                      updateFilter={updateFilter}
                      clearFilters={clearFilters}
                      filterOptions={filterOptions}
                    />
                  </div>
                  <div className="shrink-0 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] border-t border-black/5 dark:border-white/10">
                    <button
                      onClick={() => setFilterSheetOpen(false)}
                      className="w-full btn btn-primary btn-lg"
                    >
                      Show {total} result{total !== 1 ? 's' : ''}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Main content */}
            <main className="flex-1 min-w-0 mt-4 lg:mt-0">
              {/* Active filter chips — one horizontally-scrollable row */}
              {chips.length > 0 && (
                <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
                  {chips.map(chip => (
                    <button
                      key={chip.key}
                      onClick={() => removeChip(chip)}
                      className="shrink-0 flex items-center gap-1 pl-3 pr-2 h-8 rounded-full bg-dbb-accent/10 text-dbb-accent text-xs font-medium hover:bg-dbb-accent/15 transition-colors"
                    >
                      {chip.label}
                      <X className="w-3 h-3" />
                    </button>
                  ))}
                  <button
                    onClick={clearFilters}
                    className="shrink-0 text-xs text-gray-500 dark:text-gray-400 hover:text-dbb-accent transition-colors underline underline-offset-2"
                  >
                    Clear all
                  </button>
                </div>
              )}

              {/* Result toolbar — sort control lives here, directly above the grid */}
              <div className="flex items-center justify-between mb-4">
                <select
                  value={filters.sortBy}
                  onChange={(e) => updateFilter('sortBy', e.target.value)}
                  aria-label="Sort by"
                  className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
                >
                  {Object.entries(SORT_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                {hasMore && !loading && (
                  <p className="text-xs text-gray-500">Scroll for more</p>
                )}
              </div>

              {loading ? (
                <LoadingSkeleton count={12} />
              ) : error ? (
                <div className="text-center py-12">
                  <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
                  <button onClick={() => loadListings()} className="btn btn-primary btn-md">
                    Try Again
                  </button>
                </div>
              ) : listings.length === 0 ? (
                <div className="text-center py-16">
                  <Grid className="w-16 h-16 mx-auto mb-4 text-gray-600" />
                  <h2 className="text-xl font-semibold mb-2">
                    {hasActiveFilters ? 'No listings match your filters' : 'No cards on the bazaar yet'}
                  </h2>
                  <p className="text-gray-500 dark:text-gray-400 mb-4">
                    {hasActiveFilters
                      ? 'Try adjusting your filters or clearing them.'
                      : 'List yours from your library to get started.'}
                  </p>
                  {hasActiveFilters ? (
                    <button onClick={clearFilters} className="btn btn-primary btn-md">
                      Clear All Filters
                    </button>
                  ) : (
                    <a href="/library" className="btn btn-primary btn-md inline-block">
                      Go to your library →
                    </a>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 min-[900px]:grid-cols-4 min-[1440px]:grid-cols-5 gap-3 sm:gap-4 lg:gap-5">
                    {listings.map(listing => (
                      <BazaarCard
                        key={listing.id}
                        listing={listing}
                        priceData={prices[`${listing.library_cards?.scryfall_id}:${listing.library_cards?.foil || 'normal'}`]}
                        onClick={() => setSelectedListing(listing)}
                      />
                    ))}
                  </div>
                  <div id="bazaar-sentinel" className="h-20 flex items-center justify-center py-4">
                    {loadingMore && (
                      <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading more...
                      </div>
                    )}
                    {!hasMore && listings.length > 0 && (
                      <div className="text-gray-600 dark:text-gray-500 text-sm">All {total} listings shown</div>
                    )}
                  </div>
                </>
              )}
            </main>
          </div>
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
