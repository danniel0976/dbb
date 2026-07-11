'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Grid, Filter, X, Search, Loader2 } from 'lucide-react'
import Sidebar from '@/components/Sidebar'
import BazaarCard from '@/components/BazaarCard'
import LoadingSkeleton from '@/components/LoadingSkeleton'

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

export default function BazaarView({ initialData, filterOptions: initialFilterOptions }) {
  const [listings, setListings] = useState(initialData?.listings || [])
  const [total, setTotal] = useState(initialData?.total || 0)
  const [hasMore, setHasMore] = useState(initialData?.hasMore || false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(!initialData)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [filters, setFilters] = useState(INITIAL_FILTERS)
  const [filterOptions] = useState(initialFilterOptions || { sets: [], rarities: [], cardTypes: [] })

  const PAGE_SIZE = 24
  const searchTimeout = useRef(null)

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

  const clearFilters = () => {
    setFilters(INITIAL_FILTERS)
    loadListings(INITIAL_FILTERS)
  }

  const hasActiveFilters = Object.entries(filters).some(([key, v]) => {
    if (key === 'sortBy') return v !== 'newest'
    if (key === 'search') return v !== ''
    if (key === 'isFoil') return v !== null
    if (Array.isArray(v)) return v.length > 0
    return v !== null && v !== undefined
  })

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      {/* Sub-header */}
      <div className="sticky top-[73px] z-30 bg-dbb-primary/95 backdrop-blur border-b border-dbb-accent/10">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="lg:hidden p-2 hover:bg-dbb-secondary rounded-lg transition-colors"
            >
              <Filter className="w-5 h-5" />
            </button>
            <h2 className="text-lg font-semibold text-white">Bazaar</h2>
            {!loading && (
              <span className="text-sm text-gray-500">
                {total} listing{total !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search cards..."
                value={filters.search}
                onChange={(e) => updateFilter('search', e.target.value)}
                className="w-40 sm:w-64 bg-dbb-secondary border border-gray-700 rounded-lg pl-9 pr-8 py-2 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-500"
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
                className="flex items-center gap-1 text-sm text-dbb-accent hover:text-red-400 transition-colors"
              >
                <X className="w-4 h-4" /> Clear
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex">
        {/* Sidebar — Desktop */}
        <aside className="hidden lg:block w-72 fixed left-0 top-[121px] bottom-0 overflow-y-auto border-r border-dbb-accent/10 bg-dbb-primary/50">
          <Sidebar
            filters={filters}
            updateFilter={updateFilter}
            clearFilters={clearFilters}
            filterOptions={filterOptions}
          />
        </aside>

        {/* Sidebar — Mobile */}
        {sidebarOpen && (
          <>
            <div
              className="fixed inset-0 bg-black/50 z-40 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
            <aside className="fixed left-0 top-0 bottom-0 w-80 z-50 lg:hidden">
              <div className="h-full bg-dbb-primary overflow-y-auto">
                <div className="p-4 border-b border-dbb-accent/10 flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Filters</h2>
                  <button onClick={() => setSidebarOpen(false)} className="p-2 hover:bg-dbb-secondary rounded-lg">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <Sidebar
                  filters={filters}
                  updateFilter={updateFilter}
                  clearFilters={clearFilters}
                  filterOptions={filterOptions}
                />
              </div>
            </aside>
          </>
        )}

        {/* Main Content */}
        <main className="flex-1 lg:ml-72 p-4 lg:p-6">
          {/* Sort control */}
          <div className="mb-4 flex items-center justify-between">
            <select
              value={filters.sortBy}
              onChange={(e) => updateFilter('sortBy', e.target.value)}
              className="bg-dbb-secondary border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
            >
              <option value="newest">Newest</option>
              <option value="price_high">Price: High → Low</option>
              <option value="price_low">Price: Low → High</option>
              <option value="name_az">Name: A–Z</option>
              <option value="rarity">Rarity</option>
            </select>
            {hasMore && !loading && (
              <p className="text-xs text-gray-500">Scroll for more</p>
            )}
          </div>

          {loading ? (
            <LoadingSkeleton count={12} />
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-red-400 mb-4">{error}</p>
              <button onClick={() => loadListings()} className="btn-primary">
                Try Again
              </button>
            </div>
          ) : listings.length === 0 ? (
            <div className="text-center py-16">
              <Grid className="w-16 h-16 mx-auto mb-4 text-gray-600" />
              <h2 className="text-xl font-semibold mb-2">
                {hasActiveFilters ? 'No listings match your filters' : 'No cards on the bazaar yet'}
              </h2>
              <p className="text-gray-400 mb-4">
                {hasActiveFilters
                  ? 'Try adjusting your filters or clearing them.'
                  : 'List yours from your library to get started.'}
              </p>
              {hasActiveFilters ? (
                <button onClick={clearFilters} className="btn-primary">
                  Clear All Filters
                </button>
              ) : (
                <a href="/library" className="btn-primary inline-block">
                  Go to your library →
                </a>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {listings.map(listing => (
                  <BazaarCard key={listing.id} listing={listing} />
                ))}
              </div>
              <div id="bazaar-sentinel" className="h-20 flex items-center justify-center py-4">
                {loadingMore && (
                  <div className="flex items-center gap-2 text-gray-400 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading more...
                  </div>
                )}
                {!hasMore && listings.length > 0 && (
                  <div className="text-gray-500 text-sm">All {total} listings shown</div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
