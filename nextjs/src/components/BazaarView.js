'use client'

import { useState, useEffect, useCallback, useReducer, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Grid, Filter, X, Search, Loader2, Layers, SortAsc } from 'lucide-react'
import Sidebar from '@/components/Sidebar'
import FilterSheet from '@/components/FilterSheet'
import BazaarCard from '@/components/BazaarCard'
import BazaarDetailModal from '@/components/BazaarDetailModal'
import LoadingSkeleton from '@/components/LoadingSkeleton'
import ClaimSalesBrowse from '@/components/ClaimSalesBrowse'
import { useToast } from '@/components/Toast'
import {
  EMPTY_BAZAAR_FILTERS,
  parseBazaarQueryState,
  serializeBazaarQueryState,
  buildBazaarFilterChips,
  BAZAAR_CHIP_CLEAR_PATCH,
  hasActiveBazaarFilters,
} from '@/lib/bazaarSearchState'
import { filterSheetReducer, initFilterSheetState } from '@/lib/filterSheetState'

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'price_high', label: 'Price: High → Low' },
  { value: 'price_low', label: 'Price: Low → High' },
  { value: 'name_az', label: 'Name: A–Z' },
  { value: 'rarity', label: 'Rarity' },
]

const INITIAL_FILTERS = EMPTY_BAZAAR_FILTERS

export default function BazaarView({ initialData, filterOptions: initialFilterOptions, userId }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialQueryState = useRef(parseBazaarQueryState(searchParams)).current

  const [listings, setListings] = useState(initialData?.listings || [])
  const [total, setTotal] = useState(initialData?.total || 0)
  const [hasMore, setHasMore] = useState(initialData?.hasMore || false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(!initialData)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [filters, setFilters] = useState(initialQueryState)
  const [filterOptions] = useState(initialFilterOptions || { sets: [], rarities: [], cardTypes: [] })
  const [selectedListing, setSelectedListing] = useState(null)
  const [prices, setPrices] = useState({})
  const [bazaarSection, setBazaarSection] = useState('singles') // 'singles' | 'claim_sales'
  const { toast } = useToast()

  const PAGE_SIZE = 24
  const searchTimeout = useRef(null)
  const currentFilters = useRef(filters)
  const reqGenRef = useRef(0)
  const abortRef = useRef(null)

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

  const buildParams = useCallback((f = filters, p = 1) => {
    const params = new URLSearchParams({ page: String(p), sort: f.sortBy })
    if (f.search) params.set('search', f.search)
    if (f.setCode) params.set('setCode', f.setCode)
    if (f.rarities?.length) params.set('rarities', f.rarities.join(','))
    if (f.colors?.length) params.set('colors', f.colors.join(','))
    if (f.cardType) params.set('cardType', f.cardType)
    if (f.isFoil !== null && f.isFoil !== undefined) params.set('isFoil', String(f.isFoil))
    if (f.minPrice !== null && f.minPrice !== undefined && f.minPrice !== '') params.set('minPrice', String(f.minPrice))
    if (f.maxPrice !== null && f.maxPrice !== undefined && f.maxPrice !== '') params.set('maxPrice', String(f.maxPrice))
    return params
  }, [filters])

  const loadListings = useCallback(async (f = filters) => {
    const gen = ++reqGenRef.current
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/listings?${buildParams(f, 1)}`, { signal: controller.signal })
      if (gen !== reqGenRef.current) return // a newer request superseded this one
      if (!res.ok) throw new Error('Failed to load listings')
      const data = await res.json()
      if (gen !== reqGenRef.current) return
      setListings(data.listings || [])
      setTotal(data.total || 0)
      setHasMore(data.hasMore || false)
      setPage(1)
    } catch (err) {
      if (err?.name === 'AbortError') return
      if (gen !== reqGenRef.current) return
      setError('Failed to load bazaar listings.')
    } finally {
      if (gen === reqGenRef.current) setLoading(false)
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

  // Commits Bazaar filter state to the URL so it can be bookmarked, shared,
  // or restored via reload/Back-Forward (Phase 41 tech audit P1 #7), mirroring
  // Library's/Claim Sales' canonical parse/serialize pattern.
  const pushUrl = useCallback((f) => {
    const params = serializeBazaarQueryState(f)
    router.push(`?${params}`, { scroll: false })
  }, [router])

  const updateFilter = (key, value) => {
    const next = { ...filters, [key]: value }
    setFilters(next)
    currentFilters.current = next
    pushUrl(next)
    clearTimeout(searchTimeout.current)
    if (key === 'search') {
      searchTimeout.current = setTimeout(() => loadListings(next), 300)
    } else {
      loadListings(next)
    }
  }

  const clearFilters = () => {
    setFilters(INITIAL_FILTERS)
    currentFilters.current = INITIAL_FILTERS
    pushUrl(INITIAL_FILTERS)
    loadListings(INITIAL_FILTERS)
  }

  // Removes exactly one applied predicate, leaving the rest of the filter
  // state untouched (chip "remove this one" semantics).
  const handleRemoveChip = useCallback((key) => {
    const patch = BAZAAR_CHIP_CLEAR_PATCH[key]
    if (!patch) return
    const next = { ...currentFilters.current, ...patch }
    setFilters(next)
    currentFilters.current = next
    pushUrl(next)
    loadListings(next)
  }, [pushUrl, loadListings])

  const hasActiveFilters = hasActiveBazaarFilters(filters)
  const activeChips = buildBazaarFilterChips(filters, filterOptions)

  // Mobile filter sheet — staged draft state (Phase 41 feature #1). Edits
  // inside the sheet only mutate `sheet.draft`; nothing is applied/committed
  // to `filters`/the URL/a request until Apply. Closing without Apply just
  // dispatches CLOSE and the draft is discarded, leaving `filters` untouched.
  const [sheet, dispatchSheet] = useReducer(filterSheetReducer, filters, initFilterSheetState)
  const filtersButtonRef = useRef(null)
  const openSheet = () => dispatchSheet({ type: 'OPEN', applied: filters })
  const closeSheet = () => dispatchSheet({ type: 'CLOSE' })
  const updateDraftFilter = (key, value) => dispatchSheet({ type: 'EDIT', patch: { [key]: value } })
  const clearDraftFilters = () => dispatchSheet({ type: 'REPLACE_DRAFT', draft: EMPTY_BAZAAR_FILTERS })
  const applySheetFilters = () => {
    const next = sheet.draft
    dispatchSheet({ type: 'APPLY' })
    setFilters(next)
    currentFilters.current = next
    pushUrl(next)
    loadListings(next)
  }
  const draftChipCount = buildBazaarFilterChips(sheet.draft, filterOptions).length

  // Reconstruct state from the URL on Back/Forward navigation, mirroring
  // LibraryView's popstate sync so a copied/reloaded/back-navigated Bazaar
  // URL reruns the same query rather than silently diverging.
  const isFirstUrlSync = useRef(true)
  useEffect(() => {
    if (isFirstUrlSync.current) {
      isFirstUrlSync.current = false
      return
    }
    const parsed = parseBazaarQueryState(searchParams)
    if (JSON.stringify(parsed) === JSON.stringify(currentFilters.current)) return
    setFilters(parsed)
    currentFilters.current = parsed
    loadListings(parsed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // A bookmarked/reloaded URL with non-default filters must not silently
  // show the server-prefetched unfiltered "newest 24" — reload once on
  // mount if the parsed URL state differs from defaults.
  const didUrlAutoFetch = useRef(false)
  useEffect(() => {
    if (didUrlAutoFetch.current) return
    didUrlAutoFetch.current = true
    if (JSON.stringify(initialQueryState) !== JSON.stringify(EMPTY_BAZAAR_FILTERS)) {
      loadListings(initialQueryState)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      {/* Sub-header */}
      <div className="sticky top-[57px] z-30 bg-white/95 dark:bg-dbb-primary/95 backdrop-blur border-b border-gray-200 dark:border-dbb-tertiary/30">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Bazaar</h1>
            {/* Section toggle */}
            <div className="flex items-center gap-1 ml-1">
              <button
                onClick={() => setBazaarSection('singles')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-dbb text-xs font-medium transition-colors ${
                  bazaarSection === 'singles'
                    ? 'bg-dbb-accent text-white'
                    : 'text-gray-500 dark:text-gray-400 hover:text-dbb-accent'
                }`}
              >
                <Grid className="w-3.5 h-3.5" />
                Singles
              </button>
              <button
                onClick={() => setBazaarSection('claim_sales')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-dbb text-xs font-medium transition-colors ${
                  bazaarSection === 'claim_sales'
                    ? 'bg-dbb-accent text-white'
                    : 'text-gray-500 dark:text-gray-400 hover:text-dbb-accent'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Claim Sales
              </button>
            </div>
            {bazaarSection === 'singles' && !loading && (
              <span className="text-sm text-gray-600 dark:text-gray-500">
                {total} listing{total !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className={`hidden lg:flex items-center gap-2 ${bazaarSection === 'claim_sales' ? '!hidden' : ''}`}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search cards..."
                value={filters.search}
                onChange={(e) => updateFilter('search', e.target.value)}
                className="w-40 sm:w-64 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb pl-9 pr-8 py-2 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-500"
              />
              {filters.search && (
                <button
                  onClick={() => updateFilter('search', '')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:text-red-400 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 text-sm text-dbb-accent hover:text-dbb-accent-hov transition-colors"
              >
                <X className="w-4 h-4" /> Clear
              </button>
            )}
          </div>
        </div>

        {/* Mobile discovery toolbar (Phase 41 feature #1): row 1 = full-width
            search + clear, row 2 = Filters (staged sheet, active count) +
            Sort + result count. Desktop keeps the row above + sidebar. */}
        {bazaarSection === 'singles' && (
          <div className="lg:hidden container mx-auto px-4 pb-3 space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search cards..."
                value={filters.search}
                onChange={(e) => updateFilter('search', e.target.value)}
                className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb pl-9 pr-9 py-2.5 min-h-[44px] text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-500"
              />
              {filters.search && (
                <button
                  onClick={() => updateFilter('search', '')}
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center hover:text-red-400 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                ref={filtersButtonRef}
                onClick={openSheet}
                className={`flex items-center gap-1.5 px-3 min-h-[44px] text-sm border rounded-dbb transition-colors ${
                  hasActiveFilters
                    ? 'border-dbb-accent text-dbb-accent bg-dbb-accent/10'
                    : 'border-gray-200 dark:border-dbb-tertiary/50 text-gray-500 dark:text-gray-400'
                }`}
              >
                <Filter className="w-4 h-4" />
                Filters
                {activeChips.length > 0 && (
                  <span className="ml-0.5 bg-dbb-accent text-white text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {activeChips.length}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <SortAsc className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0" />
                <select
                  value={filters.sortBy}
                  onChange={(e) => updateFilter('sortBy', e.target.value)}
                  className="w-full min-h-[44px] bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-2 text-sm focus:border-dbb-accent focus:outline-none"
                >
                  {SORT_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <span className="text-xs text-gray-600 dark:text-gray-500 whitespace-nowrap shrink-0">
                {loading ? '…' : `${total} result${total !== 1 ? 's' : ''}`}
              </span>
            </div>
          </div>
        )}

        <FilterSheet
          open={sheet.open}
          title="Filters"
          onClose={closeSheet}
          onApply={applySheetFilters}
          onClearAll={clearDraftFilters}
          applyLabel={draftChipCount > 0 ? `Apply filters (${draftChipCount})` : 'Apply filters'}
          triggerRef={filtersButtonRef}
        >
          <Sidebar
            filters={sheet.draft}
            updateFilter={updateDraftFilter}
            clearFilters={clearDraftFilters}
            filterOptions={filterOptions}
          />
        </FilterSheet>

        {/* Active filter chips — dismissible, "remove this one predicate" semantics */}
        {bazaarSection === 'singles' && activeChips.length > 0 && (
          <div className="container mx-auto px-4 pb-3 flex flex-wrap items-center gap-2">
            {activeChips.map(chip => (
              <button
                key={chip.key}
                onClick={() => handleRemoveChip(chip.key)}
                className="flex items-center gap-1 px-2.5 py-0.5 text-xs bg-dbb-accent/10 border border-dbb-accent/40 text-dbb-accent rounded-full hover:bg-dbb-accent/20 transition-colors"
              >
                {chip.label}
                <X className="w-3 h-3 ml-0.5" />
              </button>
            ))}
            <button
              onClick={clearFilters}
              className="text-xs text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline transition-colors"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {bazaarSection === 'claim_sales' ? (
        <ClaimSalesBrowse userId={userId} />
      ) : (
        <div className="flex">
          {/* Sidebar — Desktop */}
          <aside className="hidden lg:block w-72 fixed left-0 top-[105px] bottom-0 overflow-y-auto border-r border-dbb-tertiary/30 bg-gray-50 dark:bg-dbb-primary/50">
            <Sidebar
              filters={filters}
              updateFilter={updateFilter}
              clearFilters={clearFilters}
              filterOptions={filterOptions}
            />
          </aside>

          {/* Main Content */}
          <main className="flex-1 lg:ml-72 p-4 lg:p-6">
            {/* Sort control — desktop only; mobile uses the row-2 toolbar sort above */}
            <div className="hidden lg:flex mb-4 items-center justify-between">
              <select
                value={filters.sortBy}
                onChange={(e) => updateFilter('sortBy', e.target.value)}
                className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
              >
                {SORT_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
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
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-4">
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
