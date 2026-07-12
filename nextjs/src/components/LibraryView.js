'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import LibraryCard from '@/components/LibraryCard'
import CardDetailModal from '@/components/CardDetailModal'
import BinderPicker from '@/components/BinderPicker'
import AdvancedSearchPanel, { buildFilterChips } from '@/components/AdvancedSearchPanel'
import AddCardModal from '@/components/AddCardModal'
import { useToast } from '@/components/Toast'
import { Search, SortAsc, CheckSquare, X, Star, StarOff, Trash2, FolderOpen, Filter, Tag, PlusCircle } from 'lucide-react'
import Link from 'next/link'

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'set', label: 'Set / Number' },
  { value: 'cmc', label: 'Mana value' },
  { value: 'rarity', label: 'Rarity' },
]

function parseInitialFilters(searchParams) {
  const colorsStr = searchParams.get('colors') || ''
  const colors = colorsStr ? colorsStr.split('') : []
  const rarityStr = searchParams.get('rarity') || ''
  const rarity = rarityStr ? rarityStr.split(',') : []
  return {
    colors: colors.length ? colors : [],
    color_mode: searchParams.get('color_mode') || 'or',
    type_line: searchParams.get('type_line') || '',
    cmc_min: searchParams.get('cmc_min') || '',
    cmc_max: searchParams.get('cmc_max') || '',
    rarity: rarity.length ? rarity : [],
    foil: searchParams.get('foil') || 'all',
    starred: searchParams.get('starred') === '1',
    set_code: searchParams.get('set') || '',
    binder_id: searchParams.get('binder_id') || '',
  }
}

function serializeFilters(filters, q, sort) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (sort && sort !== 'newest') params.set('sort', sort)
  if (filters.colors && filters.colors.length) params.set('colors', filters.colors.join(''))
  if (filters.colors && filters.colors.length && filters.color_mode && filters.color_mode !== 'or') {
    params.set('color_mode', filters.color_mode)
  }
  if (filters.type_line) params.set('type_line', filters.type_line)
  if (filters.cmc_min != null && filters.cmc_min !== '') params.set('cmc_min', filters.cmc_min)
  if (filters.cmc_max != null && filters.cmc_max !== '') params.set('cmc_max', filters.cmc_max)
  if (filters.rarity && filters.rarity.length) params.set('rarity', filters.rarity.join(','))
  if (filters.foil && filters.foil !== 'all') params.set('foil', filters.foil)
  if (filters.starred) params.set('starred', '1')
  if (filters.set_code) params.set('set', filters.set_code)
  if (filters.binder_id) params.set('binder_id', filters.binder_id)
  return params
}

function hasActiveFilters(filters) {
  return (
    (filters.colors && filters.colors.length > 0) ||
    !!filters.type_line ||
    (filters.cmc_min != null && filters.cmc_min !== '') ||
    (filters.cmc_max != null && filters.cmc_max !== '') ||
    (filters.rarity && filters.rarity.length > 0) ||
    (filters.foil && filters.foil !== 'all') ||
    !!filters.starred ||
    !!filters.set_code ||
    !!filters.binder_id
  )
}

const EMPTY_FILTERS = {
  colors: [],
  color_mode: 'or',
  type_line: '',
  cmc_min: '',
  cmc_max: '',
  rarity: [],
  foil: 'all',
  starred: false,
  set_code: '',
  binder_id: '',
}

export default function LibraryView({ userId, initialData, binders = [], binderId }) {
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [cards, setCards] = useState(initialData?.cards || [])
  const [total, setTotal] = useState(initialData?.total || 0)
  const [hasMore, setHasMore] = useState(initialData?.hasMore || false)
  const [page, setPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sort, setSort] = useState('newest')
  const [q, setQ] = useState('')
  const [selectedCard, setSelectedCard] = useState(null)
  const [advFilters, setAdvFilters] = useState(() => parseInitialFilters(searchParams))
  const [showPanel, setShowPanel] = useState(false)

  // Multi-select state
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [showBinderPicker, setShowBinderPicker] = useState(false)
  const [showListPicker, setShowListPicker] = useState(false)
  const [listMultiplier, setListMultiplier] = useState(2.5)
  const [listDuration, setListDuration] = useState(24)
  const [listing, setListing] = useState(false)
  const [showAddCard, setShowAddCard] = useState(false)

  const sentinelRef = useRef(null)
  const searchTimeout = useRef(null)
  const currentSort = useRef(sort)
  const currentQ = useRef(q)
  const currentFilters = useRef(advFilters)
  const resetPending = useRef(false)
  const abortControllerRef = useRef(null)

  const buildApiParams = useCallback((p = 1, overrides = {}) => {
    const f = overrides.filters ?? currentFilters.current
    const params = new URLSearchParams({
      page: String(p),
      sort: overrides.sort ?? currentSort.current,
      q: overrides.q ?? currentQ.current,
    })
    if (binderId) params.set('binder_id', binderId)

    if (f.colors && f.colors.length) params.set('colors', f.colors.join(''))
    if (f.colors && f.colors.length && f.color_mode && f.color_mode !== 'or') {
      params.set('color_mode', f.color_mode)
    }
    if (f.type_line) params.set('type_line', f.type_line)
    if (f.cmc_min != null && f.cmc_min !== '') params.set('cmc_min', String(f.cmc_min))
    if (f.cmc_max != null && f.cmc_max !== '') params.set('cmc_max', String(f.cmc_max))
    if (f.rarity && f.rarity.length) params.set('rarity', f.rarity.join(','))
    if (f.foil && f.foil !== 'all') params.set('foil', f.foil)
    if (f.starred) params.set('starred', '1')
    if (f.set_code) params.set('set', f.set_code)
    if (f.binder_id && !binderId) params.set('binder_id', f.binder_id)

    return params
  }, [binderId])

  const pushUrl = useCallback((overrides = {}) => {
    const urlParams = serializeFilters(
      overrides.filters ?? currentFilters.current,
      overrides.q ?? currentQ.current,
      overrides.sort ?? currentSort.current
    )
    // Preserve the ?binder= param managed by BinderRail
    const binderParam = searchParams.get('binder')
    if (binderParam) urlParams.set('binder', binderParam)
    router.push(`?${urlParams}`, { scroll: false })
  }, [router, searchParams])

  const reload = useCallback(async (overrides = {}) => {
    // Cancel any in-flight request before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller

    resetPending.current = true
    setSelectedIds(new Set())
    try {
      const params = buildApiParams(1, overrides)
      const res = await fetch(`/api/library?${params}`, { signal: controller.signal })
      if (!res.ok) {
        toast('Failed to load library', 'error')
        return
      }
      const data = await res.json()
      setCards(data.cards || [])
      setTotal(data.total || 0)
      setHasMore(data.hasMore || false)
      setPage(1)
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast('Failed to load library', 'error')
      }
    } finally {
      resetPending.current = false
    }
  }, [toast, buildApiParams])

  const handleSortChange = (newSort) => {
    setSort(newSort)
    currentSort.current = newSort
    pushUrl({ sort: newSort })
    reload({ sort: newSort })
  }

  const handleSearchChange = (newQ) => {
    setQ(newQ)
    currentQ.current = newQ
    pushUrl({ q: newQ })
    clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      reload({ q: newQ })
    }, 300)
  }

  const handleFiltersChange = useCallback((newFilters) => {
    setAdvFilters(newFilters)
    currentFilters.current = newFilters
    pushUrl({ filters: newFilters })
    clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      reload({ filters: newFilters })
    }, 200)
  }, [pushUrl, reload])

  const handleRemoveChip = useCallback((key) => {
    const patches = {
      colors: { colors: [], color_mode: 'or' },
      type_line: { type_line: '' },
      cmc_min: { cmc_min: '' },
      cmc_max: { cmc_max: '' },
      rarity: { rarity: [] },
      foil: { foil: 'all' },
      starred: { starred: false },
      set_code: { set_code: '' },
      binder_id: { binder_id: '' },
    }
    if (patches[key]) {
      handleFiltersChange({ ...currentFilters.current, ...patches[key] })
    }
  }, [handleFiltersChange])

  const handleClearAllFilters = useCallback(() => {
    handleFiltersChange({ ...EMPTY_FILTERS })
  }, [handleFiltersChange])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || resetPending.current) return
    setLoadingMore(true)
    try {
      const nextPage = page + 1
      const params = buildApiParams(nextPage)
      const res = await fetch(`/api/library?${params}`)
      if (!res.ok) return
      const data = await res.json()
      setCards(prev => [...prev, ...(data.cards || [])])
      setPage(nextPage)
      setHasMore(data.hasMore || false)
    } catch {
      toast('Failed to load more cards', 'error')
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, page, toast, buildApiParams])

  // Auto-fetch on mount when no server-prefetched data (e.g. after binder switch)
  const didAutoFetch = useRef(false)
  useEffect(() => {
    if (didAutoFetch.current) return
    didAutoFetch.current = true
    if (!initialData?.cards?.length) {
      reload()
    }
  }, [reload]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore() },
      { rootMargin: '300px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore])

  // Card actions
  const handleStar = useCallback(async (libraryRow) => {
    const newStarred = !libraryRow.starred
    setCards(prev => prev.map(c => c.id === libraryRow.id ? { ...c, starred: newStarred } : c))
    try {
      const res = await fetch(`/api/library/${libraryRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starred: newStarred }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setCards(prev => prev.map(c => c.id === libraryRow.id ? { ...c, starred: libraryRow.starred } : c))
      toast('Failed to update star', 'error')
    }
  }, [toast])

  const handleDelete = useCallback(async (libraryRow) => {
    if (!confirm(`Remove ${libraryRow.card_index?.name || 'this card'} from your library?`)) return
    try {
      const res = await fetch(`/api/library/${libraryRow.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      setCards(prev => prev.filter(c => c.id !== libraryRow.id))
      setTotal(t => t - 1)
      toast('Card removed', 'success')
    } catch {
      toast('Failed to remove card', 'error')
    }
  }, [toast])

  const handleSaveFromModal = useCallback((updatedCard) => {
    setCards(prev => prev.map(c => c.id === updatedCard.id ? updatedCard : c))
  }, [])

  const handleDeleteFromModal = useCallback((id) => {
    setCards(prev => prev.filter(c => c.id !== id))
    setTotal(t => t - 1)
  }, [])

  // Multi-select helpers
  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = () => setSelectedIds(new Set(cards.map(c => c.id)))
  const clearSelection = () => setSelectedIds(new Set())

  const exitMultiSelect = () => {
    setMultiSelect(false)
    setSelectedIds(new Set())
  }

  const handleBulkStar = async (starred) => {
    const ids = [...selectedIds]
    if (!ids.length) return
    try {
      const res = await fetch('/api/library/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: starred ? 'star' : 'unstar' }),
      })
      if (!res.ok) throw new Error()
      setCards(prev => prev.map(c => selectedIds.has(c.id) ? { ...c, starred } : c))
      toast(`${ids.length} card${ids.length !== 1 ? 's' : ''} ${starred ? 'starred' : 'unstarred'}`, 'success')
      clearSelection()
    } catch {
      toast('Bulk update failed', 'error')
    }
  }

  const handleBulkDelete = async () => {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (!confirm(`Delete ${ids.length} card${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return
    try {
      const res = await fetch('/api/library/bulk', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) throw new Error()
      setCards(prev => prev.filter(c => !selectedIds.has(c.id)))
      setTotal(t => t - ids.length)
      toast(`${ids.length} card${ids.length !== 1 ? 's' : ''} deleted`, 'success')
      clearSelection()
    } catch {
      toast('Bulk delete failed', 'error')
    }
  }

  const handleBulkMove = async (targetBinder) => {
    const ids = [...selectedIds]
    setShowBinderPicker(false)
    if (!ids.length) return
    try {
      const res = await fetch('/api/library/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'move', binder_id: targetBinder.id }),
      })
      if (!res.ok) throw new Error()
      if (binderId && binderId !== targetBinder.id) {
        setCards(prev => prev.filter(c => !selectedIds.has(c.id)))
        setTotal(t => t - ids.length)
      }
      toast(`${ids.length} card${ids.length !== 1 ? 's' : ''} moved to "${targetBinder.name}"`, 'success')
      clearSelection()
    } catch {
      toast('Move failed', 'error')
    }
  }

  const handleBulkList = async () => {
    const ids = [...selectedIds]
    setShowListPicker(false)
    setListing(true)
    try {
      const items = ids.map(id => ({
        library_card_id: id,
        multiplier: listMultiplier,
        duration_hours: listDuration,
      }))
      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error()
      toast(`${ids.length} card${ids.length !== 1 ? 's' : ''} listed on Bazaar`, 'success')
      clearSelection()
    } catch {
      toast('Failed to list cards on Bazaar', 'error')
    } finally {
      setListing(false)
    }
  }

  const selectedCount = selectedIds.size
  const activeChips = buildFilterChips(advFilters, binders, [])
  const filterActive = hasActiveFilters(advFilters)
  const activeFilterCount = activeChips.length

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search by name..."
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full bg-dbb-secondary border border-gray-700 rounded-lg pl-9 pr-4 py-2 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-600"
          />
        </div>
        <div className="flex items-center gap-2">
          <SortAsc className="w-4 h-4 text-gray-500" />
          <select
            value={sort}
            onChange={(e) => handleSortChange(e.target.value)}
            className="bg-dbb-secondary border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none"
          >
            {SORTS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="text-sm text-gray-500">
          {total} card{total !== 1 ? 's' : ''}
        </div>

        {/* Multi-select toggle */}
        <button
          onClick={() => {
            if (multiSelect) exitMultiSelect()
            else setMultiSelect(true)
          }}
          title={multiSelect ? 'Exit multi-select' : 'Multi-select'}
          className={`p-2 rounded-lg border transition-colors ${
            multiSelect
              ? 'border-dbb-accent text-dbb-accent bg-dbb-accent/10'
              : 'border-gray-700 text-gray-400 hover:border-dbb-accent/50'
          }`}
        >
          <CheckSquare className="w-4 h-4" />
        </button>

        {/* Filters button */}
        <button
          onClick={() => setShowPanel(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg transition-colors ${
            showPanel || filterActive
              ? 'border-dbb-accent text-dbb-accent bg-dbb-accent/10'
              : 'border-gray-700 text-gray-400 hover:border-dbb-accent/50'
          }`}
        >
          <Filter className="w-4 h-4" />
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-1 bg-dbb-accent text-white text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Add card button */}
        <button
          onClick={() => setShowAddCard(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-700 text-gray-400 rounded-lg hover:border-dbb-accent/50 hover:text-dbb-accent transition-colors"
          title="Add individual card"
        >
          <PlusCircle className="w-4 h-4" />
          Add card
        </button>
      </div>

      {/* Active filter chips */}
      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
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
            onClick={handleClearAllFilters}
            className="text-xs text-gray-500 hover:text-gray-300 underline transition-colors"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Advanced search panel */}
      {showPanel && (
        <AdvancedSearchPanel
          open={showPanel}
          onClose={() => setShowPanel(false)}
          filters={advFilters}
          onFiltersChange={handleFiltersChange}
          binders={binders}
          binderId={binderId}
        />
      )}

      {/* Multi-select header bar */}
      {multiSelect && (
        <div className="flex items-center gap-3 mb-4 px-4 py-2 bg-dbb-secondary/80 border border-gray-700 rounded-lg">
          <button
            onClick={selectAll}
            className="text-xs text-dbb-accent hover:underline"
          >
            Select all ({cards.length})
          </button>
          {selectedCount > 0 && (
            <button
              onClick={clearSelection}
              className="text-xs text-gray-400 hover:text-white"
            >
              Clear
            </button>
          )}
          <span className="text-xs text-gray-500 ml-auto">
            {selectedCount} selected
          </span>
        </div>
      )}

      {/* Grid */}
      {cards.length === 0 ? (
        <div className="text-center py-24">
          <div className="text-5xl mb-4">📦</div>
          <h2 className="text-xl font-semibold mb-2 text-gray-300">
            {filterActive || q ? 'No cards match your filters' : 'Your library is empty'}
          </h2>
          <p className="text-gray-500 mb-6">
            {filterActive || q
              ? 'Try adjusting your search or removing some filters.'
              : 'Import your ManaBox collection to get started.'}
          </p>
          {!filterActive && !q && (
            <div className="flex flex-col sm:flex-row items-center gap-3 justify-center">
              <Link
                href="/import"
                className="inline-block btn-primary px-6 py-2 rounded-lg"
              >
                Import collection →
              </Link>
              <button
                onClick={() => setShowAddCard(true)}
                className="inline-flex items-center gap-2 px-6 py-2 rounded-lg border border-gray-600 text-gray-400 hover:border-dbb-accent hover:text-dbb-accent transition-colors"
              >
                <PlusCircle className="w-4 h-4" />
                Add a card
              </button>
            </div>
          )}
          {(filterActive || q) && (
            <button
              onClick={handleClearAllFilters}
              className="inline-block px-6 py-2 rounded-lg border border-gray-600 text-gray-400 hover:border-dbb-accent hover:text-dbb-accent transition-colors"
            >
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {cards.map(card => (
              <div key={card.id} className="relative">
                {multiSelect && (
                  <button
                    onClick={() => toggleSelect(card.id)}
                    className={`absolute top-2 left-2 z-10 w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${
                      selectedIds.has(card.id)
                        ? 'bg-dbb-accent border-dbb-accent text-white'
                        : 'bg-dbb-primary/80 border-gray-500 hover:border-dbb-accent'
                    }`}
                  >
                    {selectedIds.has(card.id) && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                )}
                <LibraryCard
                  libraryRow={card}
                  onStar={multiSelect ? undefined : handleStar}
                  onDelete={multiSelect ? undefined : handleDelete}
                  onOpen={multiSelect ? () => toggleSelect(card.id) : setSelectedCard}
                  dimmed={multiSelect && selectedIds.size > 0 && !selectedIds.has(card.id)}
                />
              </div>
            ))}
          </div>

          <div ref={sentinelRef} className="h-12 flex items-center justify-center mt-4">
            {loadingMore && (
              <span className="text-sm text-gray-500">Loading more...</span>
            )}
            {!hasMore && cards.length > 0 && (
              <span className="text-sm text-gray-600">All {total} cards loaded</span>
            )}
          </div>
        </>
      )}

      {/* Multi-select action bar (fixed bottom) */}
      {multiSelect && selectedCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-dbb-primary border-t border-dbb-accent/30 shadow-2xl">
          <div className="container mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-white">
              {selectedCount} selected
            </span>
            <div className="flex items-center gap-2 ml-auto flex-wrap">
              <button
                onClick={() => handleBulkStar(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-600 rounded-lg text-gray-300 hover:border-dbb-gold hover:text-dbb-gold transition-colors"
              >
                <Star className="w-4 h-4" /> Star all
              </button>
              <button
                onClick={() => handleBulkStar(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-600 rounded-lg text-gray-300 hover:border-gray-400 transition-colors"
              >
                <StarOff className="w-4 h-4" /> Unstar all
              </button>
              <button
                onClick={() => setShowBinderPicker(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-600 rounded-lg text-gray-300 hover:border-dbb-accent hover:text-dbb-accent transition-colors"
              >
                <FolderOpen className="w-4 h-4" /> Move to binder
              </button>
              <button
                onClick={() => setShowListPicker(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-600 rounded-lg text-gray-300 hover:border-green-500 hover:text-green-400 transition-colors"
              >
                <Tag className="w-4 h-4" /> List on Bazaar
              </button>
              <button
                onClick={handleBulkDelete}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-red-800 rounded-lg text-red-400 hover:border-red-500 hover:text-red-300 transition-colors"
              >
                <Trash2 className="w-4 h-4" /> Delete all
              </button>
              <button
                onClick={exitMultiSelect}
                className="p-1.5 text-gray-500 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Card detail modal */}
      {selectedCard && (
        <CardDetailModal
          libraryRow={selectedCard}
          onClose={() => setSelectedCard(null)}
          onSave={handleSaveFromModal}
          onDelete={handleDeleteFromModal}
        />
      )}

      {/* Add card modal */}
      {showAddCard && (
        <AddCardModal
          binders={binders}
          onClose={() => setShowAddCard(false)}
          onAdded={(info) => {
            toast(
              info.inserted > 0
                ? `Added ${info.card_name} to library`
                : `Merged ${info.card_name} quantity`,
              'success'
            )
            reload()
          }}
        />
      )}

      {/* Binder picker modal */}
      {showBinderPicker && (
        <BinderPicker
          onSelect={handleBulkMove}
          onClose={() => setShowBinderPicker(false)}
        />
      )}

      {/* Bazaar list picker modal */}
      {showListPicker && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowListPicker(false) }}
        >
          <div className="bg-dbb-primary border border-dbb-accent/30 rounded-xl max-w-sm w-full p-6 shadow-2xl">
            <h3 className="text-lg font-bold mb-1">List on Bazaar</h3>
            <p className="text-sm text-gray-400 mb-4">
              {selectedCount} card{selectedCount !== 1 ? 's' : ''} · Price = CKD USD × multiplier
            </p>

            <p className="text-xs text-gray-500 mb-1.5 font-medium">Multiplier</p>
            <div className="flex gap-3 mb-4">
              {[2.5, 2.8, 3.0].map(m => (
                <button
                  key={m}
                  onClick={() => setListMultiplier(m)}
                  className={`flex-1 py-3 rounded-lg border text-sm font-semibold transition-colors ${
                    listMultiplier === m
                      ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                      : 'border-gray-700 text-gray-400 hover:border-dbb-accent/50'
                  }`}
                >
                  ×{m}
                </button>
              ))}
            </div>

            <p className="text-xs text-gray-500 mb-1.5 font-medium">Duration (max 24h)</p>
            <div className="flex gap-2 mb-6">
              {[1, 3, 6, 12, 24].map(h => (
                <button
                  key={h}
                  onClick={() => setListDuration(h)}
                  className={`flex-1 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    listDuration === h
                      ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                      : 'border-gray-700 text-gray-500 hover:border-gray-500'
                  }`}
                >
                  {h}h
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleBulkList}
                disabled={listing}
                className="flex-1 py-2 bg-dbb-accent hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {listing ? 'Listing...' : 'Confirm'}
              </button>
              <button
                onClick={() => setShowListPicker(false)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
