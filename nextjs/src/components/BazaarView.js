'use client'

import { useState, useEffect, useCallback, useMemo, useReducer, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown, Grid, Filter, X, Search, Loader2, Layers, SortAsc, Sparkles } from 'lucide-react'
import Sidebar from '@/components/Sidebar'
import BazaarCard from '@/components/BazaarCard'
import BazaarDetailModal from '@/components/BazaarDetailModal'
import LoadingSkeleton from '@/components/LoadingSkeleton'
import ClaimSalesBrowse from '@/components/ClaimSalesBrowse'
import FilterSheet from '@/components/FilterSheet'
import { useToast } from '@/components/Toast'
import { filterSheetReducer, initFilterSheetState } from '@/lib/filterSheetState'
import {
  EMPTY_BAZAAR_FILTERS,
  parseBazaarQueryState,
  serializeBazaarQueryState,
} from '@/lib/bazaarSearchState'
import { buildShowcaseShelves, canCommitBazaarRequest } from '@/lib/bazaarShowcase'

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'price_high', label: 'Price: High → Low' },
  { value: 'price_low', label: 'Price: Low → High' },
  { value: 'name_az', label: 'Name: A–Z' },
  { value: 'cmc_high', label: 'Mana value: High → Low' },
  { value: 'cmc_low', label: 'Mana value: Low → High' },
  { value: 'rarity_high', label: 'Rarity: High → Low' },
  { value: 'rarity_low', label: 'Rarity: Low → High' },
]

const INITIAL_FILTERS = EMPTY_BAZAAR_FILTERS

function hasSearchOrFacetPredicates(filters) {
  return Boolean(
    filters.search.trim()
    || filters.setCode
    || filters.rarities.length
    || filters.colors.length
    || filters.cardType
    || filters.isFoil !== null
    || filters.minPrice !== null
    || filters.maxPrice !== null
  )
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
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false)
  const [mobileFilterState, sendMobileFilter] = useReducer(
    filterSheetReducer,
    initialQueryState,
    initFilterSheetState
  )
  const [mobilePriceValid, setMobilePriceValid] = useState(true)
  const { toast } = useToast()

  const searchTimeout = useRef(null)
  const currentFilters = useRef(filters)
  const reqGenRef = useRef(0)
  const abortRef = useRef(null)
  const pageAbortRef = useRef(null)
  const pageRequestRef = useRef(0)
  const filterPopoverRef = useRef(null)
  const filterTriggerRef = useRef(null)
  const mobileFiltersButtonRef = useRef(null)

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

  // Desktop filter popover dismisses on Escape or an outside pointer event.
  useEffect(() => {
    if (!filterPopoverOpen) return
    const dismiss = (event) => {
      if (event.type === 'keydown' && event.key === 'Escape') {
        setFilterPopoverOpen(false)
        filterTriggerRef.current?.focus()
      } else if (event.type === 'pointerdown' && !filterPopoverRef.current?.contains(event.target)) {
        setFilterPopoverOpen(false)
      }
    }
    document.addEventListener('keydown', dismiss)
    document.addEventListener('pointerdown', dismiss)
    return () => {
      document.removeEventListener('keydown', dismiss)
      document.removeEventListener('pointerdown', dismiss)
    }
  }, [filterPopoverOpen])

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
    if (pageAbortRef.current) pageAbortRef.current.abort()
    pageRequestRef.current += 1
    setLoadingMore(false)
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/listings?${buildParams(f, 1)}`, { signal: controller.signal })
      if (!canCommitBazaarRequest(gen, reqGenRef.current)) return // a newer request superseded this one
      if (!res.ok) throw new Error('Failed to load listings')
      const data = await res.json()
      if (!canCommitBazaarRequest(gen, reqGenRef.current)) return
      setListings(data.listings || [])
      setTotal(data.total || 0)
      setHasMore(data.hasMore || false)
      setPage(1)
    } catch (err) {
      if (err?.name === 'AbortError') return
      if (!canCommitBazaarRequest(gen, reqGenRef.current)) return
      setError('Failed to load bazaar listings.')
    } finally {
      if (gen === reqGenRef.current) setLoading(false)
    }
  }, [filters, buildParams])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    const gen = reqGenRef.current
    const requestId = ++pageRequestRef.current
    const controller = new AbortController()
    pageAbortRef.current = controller
    setLoadingMore(true)
    try {
      const nextPage = page + 1
      const querySnapshot = filters
      const res = await fetch(`/api/listings?${buildParams(querySnapshot, nextPage)}`, { signal: controller.signal })
      if (!canCommitBazaarRequest(gen, reqGenRef.current) || requestId !== pageRequestRef.current) return
      if (!res.ok) return
      const data = await res.json()
      if (!canCommitBazaarRequest(gen, reqGenRef.current) || requestId !== pageRequestRef.current) return
      setListings(prev => [...prev, ...(data.listings || [])])
      setPage(nextPage)
      setHasMore(data.hasMore || false)
    } catch (err) {
      // silent
    } finally {
      if (canCommitBazaarRequest(gen, reqGenRef.current) && requestId === pageRequestRef.current) {
        setLoadingMore(false)
      }
    }
  }, [loadingMore, hasMore, page, filters, buildParams])

  // Declared before the infinite-scroll effect below: its dependency array is
  // evaluated at render time, so this const must be initialized first.
  const isResultsMode = hasSearchOrFacetPredicates(filters)

  // Infinite scroll
  useEffect(() => {
    if (loading) return
    if (!isResultsMode) return
    const sentinel = document.getElementById('bazaar-sentinel')
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting && !loadingMore && hasMore) loadMore() },
      { threshold: 0.5, rootMargin: '200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  // Keep the loaded-grid reattachment dependencies explicit; isResultsMode
  // additionally prevents Showcase from ever observing this sentinel.
  // Phase 41's focused source check covers [loadMore, loading, loadingMore, hasMore, listings.length].
  }, [loadMore, loading, loadingMore, hasMore, listings.length, isResultsMode])

  // Commits Bazaar filter state to the URL so it can be bookmarked, shared,
  // or restored via reload/Back-Forward (Phase 41 tech audit P1 #7), mirroring
  // Library's/Claim Sales' canonical parse/serialize pattern.
  const pushUrl = useCallback((f, { replace = false } = {}) => {
    const params = serializeBazaarQueryState(f)
    const url = `?${params}`
    if (replace) router.replace(url, { scroll: false })
    else router.push(url, { scroll: false })
  }, [router])

  const updateFilter = (keyOrPatch, value) => {
    const changedKey = typeof keyOrPatch === 'object'
      ? Object.keys(keyOrPatch)[0]
      : keyOrPatch
    const next = typeof keyOrPatch === 'object'
      ? { ...filters, ...keyOrPatch }
      : { ...filters, [keyOrPatch]: value }
    setFilters(next)
    currentFilters.current = next
    clearTimeout(searchTimeout.current)
    if (changedKey === 'search') {
      // Replace (not push) the history entry per keystroke so typing a
      // 5-char query yields one entry, not five — matching ClaimSalesBrowse
      // and Phase 41 Feature 5. Discrete filter/sort applies still push.
      pushUrl(next, { replace: true })
      if (next.search === '') {
        // Clearing the query reloads immediately (Feature 2); the reqGen
        // guard in loadListings still prevents a late "bo" from reappearing.
        loadListings(next)
      } else {
        searchTimeout.current = setTimeout(() => loadListings(next), 300)
      }
    } else {
      pushUrl(next)
      loadListings(next)
    }
  }

  const applyFilters = (next) => {
    setFilters(next)
    currentFilters.current = next
    pushUrl(next)
    loadListings(next)
  }

  const clearFilters = () => {
    setFilters(INITIAL_FILTERS)
    currentFilters.current = INITIAL_FILTERS
    pushUrl(INITIAL_FILTERS)
    loadListings(INITIAL_FILTERS)
  }

  const removeChip = (chip) => {
    applyFilters(chip.clear(filters))
  }

  const openMobileFilters = () => {
    setFilterPopoverOpen(false)
    sendMobileFilter({ type: 'OPEN', applied: filters })
  }
  const closeMobileFilters = useCallback(() => sendMobileFilter({ type: 'CLOSE' }), [])
  const editMobileFilters = (keyOrPatch, value) => {
    const patch = typeof keyOrPatch === 'object' ? keyOrPatch : { [keyOrPatch]: value }
    sendMobileFilter({ type: 'EDIT', patch })
  }
  const clearMobileFilters = () => {
    sendMobileFilter({ type: 'REPLACE_DRAFT', draft: { ...INITIAL_FILTERS } })
    setMobilePriceValid(true)
  }
  const applyMobileFilters = () => {
    if (!mobilePriceValid) return
    const next = mobileFilterState.draft
    sendMobileFilter({ type: 'APPLY' })
    applyFilters(next)
  }

  const hasActiveFilters = Object.entries(filters).some(([filterKey, v]) => {
    if (filterKey === 'sortBy') return v !== 'newest'
    if (filterKey === 'search') return v !== ''
    if (filterKey === 'isFoil') return v !== null
    if (Array.isArray(v)) return v.length > 0
    return v !== null && v !== undefined
  })
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

  const chips = buildChips(filters, filterOptions)
  const showcaseShelves = useMemo(() => buildShowcaseShelves(listings), [listings])

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
            <div className="relative w-full max-w-2xl">
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
          </div>
        )}
      </div>

      {bazaarSection === 'claim_sales' ? (
        <ClaimSalesBrowse userId={userId} />
      ) : (
        <div
          className="container mx-auto px-4 pb-8"
          data-bazaar-mode={isResultsMode ? 'results' : 'showcase'}
        >
          <main className="min-w-0">
            {/* A single horizontal rail replaces the permanent desktop sidebar. */}
            <div ref={filterPopoverRef} className="relative z-20 mb-5">
              <div
                className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none"
                data-bazaar-filter-rail
              >
              <div className="relative hidden lg:block shrink-0">
                <button
                  ref={filterTriggerRef}
                  type="button"
                  onClick={() => setFilterPopoverOpen(open => !open)}
                  aria-expanded={filterPopoverOpen}
                  aria-haspopup="dialog"
                  aria-controls="bazaar-desktop-filters"
                  className="flex h-10 items-center gap-2 rounded-full border border-black/[0.08] bg-white px-4 text-sm font-medium text-gray-800 shadow-dbb-sm transition-colors hover:border-dbb-accent/40 dark:border-white/[0.10] dark:bg-dbb-secondary dark:text-white"
                >
                  <Filter className="h-4 w-4" />
                  Filters
                  {chips.length > 0 && (
                    <span className="rounded-full bg-dbb-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {chips.length}
                    </span>
                  )}
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${filterPopoverOpen ? 'rotate-180' : ''}`} />
                </button>
              </div>

              <button
                ref={mobileFiltersButtonRef}
                type="button"
                onClick={openMobileFilters}
                aria-haspopup="dialog"
                className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-black/[0.08] bg-white px-4 text-sm font-medium shadow-dbb-sm lg:hidden dark:border-white/[0.10] dark:bg-dbb-secondary"
              >
                <Filter className="h-4 w-4" />
                Filters
                {chips.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-dbb-accent" />}
              </button>

              <label className="relative flex h-10 shrink-0 items-center gap-2 rounded-full border border-black/[0.08] bg-white pl-4 pr-3 text-sm shadow-dbb-sm dark:border-white/[0.10] dark:bg-dbb-secondary">
                <SortAsc className="h-4 w-4 text-gray-500" />
                <span className="sr-only">Sort listings</span>
                <select
                  value={filters.sortBy}
                  onChange={(e) => updateFilter('sortBy', e.target.value)}
                  aria-label="Sort listings"
                  className="appearance-none bg-transparent pr-5 text-sm font-medium outline-none"
                >
                  {SORT_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 h-3.5 w-3.5 text-gray-500" />
              </label>

              {chips.map(chip => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => removeChip(chip)}
                  aria-label={`Remove ${chip.label} filter`}
                  className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-dbb-accent/10 pl-4 pr-3 text-xs font-medium text-dbb-accent transition-colors hover:bg-dbb-accent/15"
                >
                  {chip.label}
                  <X className="h-3 w-3" />
                </button>
              ))}
              {chips.length > 0 && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="h-10 shrink-0 px-2 text-xs text-gray-500 underline underline-offset-2 hover:text-dbb-accent dark:text-gray-400"
                >
                  Clear all
                </button>
              )}

              {!loading && (
                <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-xs font-medium uppercase tracking-[0.14em] text-gray-500 sm:flex dark:text-gray-400">
                  {isResultsMode ? <Grid className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {isResultsMode ? 'Results' : 'Showcase'}
                </span>
              )}
              </div>
              {filterPopoverOpen && (
                    <div
                    id="bazaar-desktop-filters"
                    role="dialog"
                    aria-label="Bazaar filters"
                    className="absolute left-0 top-[calc(100%+0.5rem)] z-30 max-h-[min(70vh,620px)] w-80 overflow-y-auto rounded-dbb-lg border border-black/[0.08] bg-white shadow-dbb-md dark:border-white/[0.10] dark:bg-dbb-surface-elevated"
                  >
                    <Sidebar
                      filters={filters}
                      updateFilter={updateFilter}
                      clearFilters={clearFilters}
                      filterOptions={filterOptions}
                    />
                    </div>
                  )}
            </div>

            <FilterSheet
              open={mobileFilterState.open}
              title="Bazaar filters"
              resultCount={total}
              onClose={closeMobileFilters}
              onApply={applyMobileFilters}
              onClearAll={clearMobileFilters}
              applyLabel="Apply filters"
              applyDisabled={!mobilePriceValid}
              triggerRef={mobileFiltersButtonRef}
            >
              <Sidebar
                filters={mobileFilterState.draft}
                updateFilter={editMobileFilters}
                clearFilters={clearMobileFilters}
                filterOptions={filterOptions}
                onPriceValidityChange={setMobilePriceValid}
              />
            </FilterSheet>

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
            ) : isResultsMode ? (
              <section aria-labelledby="bazaar-results-heading" data-bazaar-results>
                <h2 id="bazaar-results-heading" className="sr-only">Bazaar results</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 min-[900px]:grid-cols-4 lg:gap-5 min-[1440px]:grid-cols-5">
                  {listings.map(listing => (
                    <div key={listing.id} className="bazaar-result-card">
                      <BazaarCard
                        listing={listing}
                        priceData={prices[`${listing.library_cards?.scryfall_id}:${listing.library_cards?.foil || 'normal'}`]}
                        onClick={() => setSelectedListing(listing)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <div className="space-y-10 sm:space-y-12" data-bazaar-showcase>
                {showcaseShelves.map(shelf => {
                  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640
                  const shouldUseGridOnMobile = shelf.items.length <= 4
                  const hasOverflow = shelf.items.length > (isMobile && shouldUseGridOnMobile ? 4 : 5)
                  return (
                    <section key={shelf.key} aria-labelledby={`showcase-${shelf.key}`}>
                      <div className="mb-4 flex items-end justify-between gap-4 max-w-2xl">
                        <div className="flex-1">
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-dbb-accent">
                            {shelf.eyebrow}
                          </p>
                          <h2 id={`showcase-${shelf.key}`} className="text-dbb-xl font-semibold tracking-heading text-gray-900 sm:text-dbb-2xl dark:text-white">
                            {shelf.title}
                          </h2>
                          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{shelf.description}</p>
                        </div>
                        {hasOverflow && (
                          <button
                            type="button"
                            className="shrink-0 text-xs font-medium text-dbb-accent hover:text-dbb-accent/80 transition-colors whitespace-nowrap"
                            aria-label={`See all ${shelf.title}`}
                          >
                            See all →
                          </button>
                        )}
                      </div>
                      {isMobile && shouldUseGridOnMobile ? (
                        <div className="grid grid-cols-2 gap-3 sm:hidden relative">
                          {shelf.items.map(listing => (
                            <div key={listing.id}>
                              <BazaarCard
                                listing={listing}
                                variant="showcase"
                                priceData={prices[`${listing.library_cards?.scryfall_id}:${listing.library_cards?.foil || 'normal'}`]}
                                onClick={() => setSelectedListing(listing)}
                              />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="bazaar-showcase-shelf -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-5 sm:gap-5 relative">
                          {shelf.items.map(listing => (
                            <div key={listing.id} className="w-[72vw] max-w-[280px] shrink-0 snap-start sm:w-[250px]">
                              <BazaarCard
                                listing={listing}
                                variant="showcase"
                                priceData={prices[`${listing.library_cards?.scryfall_id}:${listing.library_cards?.foil || 'normal'}`]}
                                onClick={() => setSelectedListing(listing)}
                              />
                            </div>
                          ))}
                          {/* Subtle right-edge gradient shadow hinting at more content */}
                          <div
                            className="pointer-events-none absolute top-0 bottom-5 right-0 w-8"
                            style={{
                              background: 'linear-gradient(to left, var(--dbb-bg) 0%, transparent 100%)'
                            }}
                          />
                        </div>
                      )}
                    </section>
                  )
                })}
              </div>
            )}

            {isResultsMode && !loading && !error && listings.length > 0 && (
              <div id="bazaar-sentinel" className="h-20 flex items-center justify-center py-4">
                {loadingMore && (
                  <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading more...
                  </div>
                )}
                {!hasMore && (
                  <div className="text-gray-600 dark:text-gray-500 text-sm">All {listings.length} listings shown</div>
                )}
                {hasMore && !loadingMore && (
                  <div className="text-gray-500 dark:text-gray-500 text-sm">Scroll for more</div>
                )}
              </div>
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
