'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import LibraryCard from '@/components/LibraryCard'
import CardDetailModal from '@/components/CardDetailModal'
import BinderPicker from '@/components/BinderPicker'
import AdvancedSearchPanel, { buildFilterChips } from '@/components/AdvancedSearchPanel'
import AddCardModal from '@/components/AddCardModal'
import CameraCapture from '@/components/CameraCapture'
import { useToast } from '@/components/Toast'
import { Search, SortAsc, CheckSquare, X, Star, StarOff, Trash2, FolderOpen, Filter, Tag, PlusCircle, Package } from 'lucide-react'
import Link from 'next/link'

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'set', label: 'Set / Number' },
  { value: 'cmc', label: 'Mana value' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'price_high', label: 'Price: High → Low' },
  { value: 'price_low', label: 'Price: Low → High' },
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
  const [initialLoading, setInitialLoading] = useState(!initialData?.cards?.length)
  const [sort, setSort] = useState('newest')
  const [q, setQ] = useState('')
  const [selectedCard, setSelectedCard] = useState(null)
  const [advFilters, setAdvFilters] = useState(() => parseInitialFilters(searchParams))
  const [showPanel, setShowPanel] = useState(false)
  const [priceMap, setPriceMap] = useState({})

  // Multi-select state
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [showBinderPicker, setShowBinderPicker] = useState(false)
  const [showListPicker, setShowListPicker] = useState(false)
  const [listMode, setListMode] = useState(null) // null = prompt, 'singles' = singles, 'claim' = claim sale
  const [listMultiplier, setListMultiplier] = useState(2.5)
  const [listDuration, setListDuration] = useState(24)
  const [listing, setListing] = useState(false)
  // Per-card quantities for bulk listing: { [library_card_id]: qty }
  const [listQuantities, setListQuantities] = useState({})
  // Claim sale fields
  const [csTitle, setCsTitle] = useState('')
  const [csDescription, setCsDescription] = useState('')
  const [csSetCode, setCsSetCode] = useState('')
  const [csDelivery, setCsDelivery] = useState('both')
  const [showAddCard, setShowAddCard] = useState(false)
  const [missingPhotoIds, setMissingPhotoIds] = useState([])
  const [photoCaptureIndex, setPhotoCaptureIndex] = useState(0)

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
    const binderParam = searchParams.get('binder')
    if (binderParam) urlParams.set('binder', binderParam)
    router.push(`?${urlParams}`, { scroll: false })
  }, [router, searchParams])

  const fetchPrices = useCallback(async (cardsToPrice) => {
    if (!cardsToPrice?.length) return
    const items = cardsToPrice.map(c => ({
      scryfall_id: c.scryfall_id,
      foil: c.foil || 'normal',
    }))
    try {
      const res = await fetch('/api/pricing/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) return
      const data = await res.json()
      setPriceMap(prev => ({ ...prev, ...data.prices }))
    } catch {}
  }, [])

  const reload = useCallback(async (overrides = {}) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller

    resetPending.current = true
    setSelectedIds(new Set())
    setInitialLoading(true)
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
      // Fetch prices for the first page of cards
      fetchPrices(data.cards)
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast('Failed to load library', 'error')
      }
    } finally {
      resetPending.current = false
      setInitialLoading(false)
    }
  }, [toast, buildApiParams, fetchPrices])

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
      // Fetch prices for newly loaded cards
      fetchPrices(data.cards)
    } catch {
      toast('Failed to load more cards', 'error')
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, page, toast, buildApiParams, fetchPrices])

  // Auto-fetch on mount when no server-prefetched data
  const didAutoFetch = useRef(false)
  useEffect(() => {
    if (didAutoFetch.current) return
    didAutoFetch.current = true
    if (!initialData?.cards?.length) {
      reload()
    } else {
      // Still fetch prices for server-prefetched data
      fetchPrices(initialData.cards)
    }
  }, [reload, fetchPrices]) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (listMode === 'claim') {
        // Claim sale
        if (!csTitle.trim()) {
          toast('Title is required for claim sale', 'error')
          setListing(false)
          setShowListPicker(true)
          return
        }
        const quantities = {}
        ids.forEach(id => { quantities[id] = listQuantities[id] || 1 })
        const res = await fetch('/api/claim-sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: csTitle.trim(),
            description: csDescription.trim() || undefined,
            set_code: csSetCode.trim() || undefined,
            duration_hours: listDuration,
            delivery_option: csDelivery,
            card_ids: ids,
            quantities,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          if (res.status === 422 && err.missing_photos?.length) {
            setMissingPhotoIds([...new Set(err.missing_photos)])
            setPhotoCaptureIndex(0)
            return
          }
          throw new Error(err.error || 'Failed')
        }
        toast(`Claim sale created with ${ids.length} card${ids.length !== 1 ? 's' : ''}`, 'success')
      } else {
        // Singles
        const items = ids.map(id => ({
          library_card_id: id,
          multiplier: listMultiplier,
          duration_hours: listDuration,
          quantity: listQuantities[id] || 1,
        }))
        const res = await fetch('/api/listings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          if (res.status === 422 && err.missing_photos?.length) {
            setMissingPhotoIds([...new Set(err.missing_photos)])
            setPhotoCaptureIndex(0)
            return
          }
          throw new Error(err.error || 'Failed')
        }
        toast(`${ids.length} card${ids.length !== 1 ? 's' : ''} listed on Bazaar`, 'success')
      }
      clearSelection()
      setListMode(null)
      setListQuantities({})
      setCsTitle('')
      setCsDescription('')
      setCsSetCode('')
      setCsDelivery('both')
    } catch (e) {
      toast(e.message || 'Failed to list cards on Bazaar', 'error')
    } finally {
      setListing(false)
    }
  }

  const selectedCount = selectedIds.size
  const selectedCards = cards.filter(c => selectedIds.has(c.id))
  const activeChips = buildFilterChips(advFilters, binders, [])
  const filterActive = hasActiveFilters(advFilters)
  const activeFilterCount = activeChips.length

  // Build skeleton grid for initial load
  const skeletonGrid = (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="bg-white dark:bg-dbb-secondary rounded-dbb overflow-hidden border border-gray-200 dark:border-dbb-tertiary/30">
          <div className="aspect-[2/3] card-skeleton" />
          <div className="p-2 space-y-1.5">
            <div className="h-3 skeleton rounded w-3/4" />
            <div className="flex justify-between">
              <div className="h-2.5 skeleton rounded w-8" />
              <div className="h-2.5 skeleton rounded w-10" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search by name..."
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb pl-9 pr-4 py-2 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
          />
        </div>
        <div className="flex items-center gap-2">
          <SortAsc className="w-4 h-4 text-gray-400 dark:text-gray-500" />
          <select
            value={sort}
            onChange={(e) => handleSortChange(e.target.value)}
            className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-dbb-accent focus:outline-none"
          >
            {SORTS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="text-sm text-gray-600 dark:text-gray-500">
          {total} card{total !== 1 ? 's' : ''}
        </div>

        {/* Multi-select toggle */}
        <button
          onClick={() => {
            if (multiSelect) exitMultiSelect()
            else setMultiSelect(true)
          }}
          title={multiSelect ? 'Exit multi-select' : 'Multi-select'}
          className={`p-2 rounded-dbb border transition-colors ${
            multiSelect
              ? 'border-dbb-accent text-dbb-accent bg-dbb-accent/10'
              : 'border-gray-200 dark:border-dbb-tertiary/50 text-gray-500 dark:text-gray-400 hover:border-dbb-accent/50'
          }`}
        >
          <CheckSquare className="w-4 h-4" />
        </button>

        {/* Filters button */}
        <button
          onClick={() => setShowPanel(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm border rounded-dbb transition-colors ${
            showPanel || filterActive
              ? 'border-dbb-accent text-dbb-accent bg-dbb-accent/10'
              : 'border-gray-200 dark:border-dbb-tertiary/50 text-gray-500 dark:text-gray-400 hover:border-dbb-accent/50'
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
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-dbb-tertiary/50 text-gray-400 rounded-dbb hover:border-dbb-accent/50 hover:text-dbb-accent transition-colors"
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
            className="text-xs text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline transition-colors"
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
        <div className="flex items-center gap-3 mb-4 px-4 py-2 bg-gray-100 dark:bg-dbb-secondary/80 border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb">
          <button
            onClick={selectAll}
            className="text-xs text-dbb-accent hover:underline"
          >
            Select all ({cards.length})
          </button>
          {selectedCount > 0 && (
            <button
              onClick={clearSelection}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
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
      {initialLoading ? (
        skeletonGrid
      ) : cards.length === 0 ? (
        <div className="text-center py-24">
          <div className="text-5xl mb-4">📦</div>
          <h2 className="text-xl font-semibold mb-2 text-gray-700 dark:text-gray-300">
            {filterActive || q ? 'No cards match your filters' : 'Your library is empty'}
          </h2>
          <p className="text-gray-500 mb-6">
            {filterActive || q
              ? 'Try adjusting your search or removing some filters.'
              : 'Import your ManaBox collection to get started.'}
          </p>
          {!filterActive && !q && (
            <div className="flex flex-col sm:flex-row items-center gap-3 justify-center">
              <Link href="/import" className="btn btn-primary btn-md">
                Import collection →
              </Link>
              <button
                onClick={() => setShowAddCard(true)}
                className="btn btn-outline btn-md"
              >
                <PlusCircle className="w-4 h-4" />
                Add a card
              </button>
            </div>
          )}
          {(filterActive || q) && (
            <button
              onClick={handleClearAllFilters}
              className="btn btn-secondary btn-md"
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
                        : 'bg-white/80 dark:bg-dbb-primary/80 border-gray-300 dark:border-gray-500 hover:border-dbb-accent'
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
                  priceData={priceMap[`${card.scryfall_id}:${card.foil || 'normal'}`]}
                />
              </div>
            ))}
          </div>

          <div ref={sentinelRef} className="h-12 flex items-center justify-center mt-4">
            {loadingMore && (
              <span className="text-sm text-gray-600 dark:text-gray-500">Loading more...</span>
            )}
            {!hasMore && cards.length > 0 && (
              <span className="text-sm text-gray-500 dark:text-gray-600">All {total} cards loaded</span>
            )}
          </div>
        </>
      )}

      {/* Multi-select action bar (fixed bottom) */}
      {multiSelect && selectedCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-dbb-primary border-t border-dbb-accent/30 shadow-2xl">
          <div className="container mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-gray-900 dark:text-white">
              {selectedCount} selected
            </span>
            <div className="flex items-center gap-2 ml-auto flex-wrap">
              <button
                onClick={() => handleBulkStar(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb text-gray-600 dark:text-gray-300 hover:border-dbb-gold hover:text-dbb-gold transition-colors"
              >
                <Star className="w-4 h-4" /> Star all
              </button>
              <button
                onClick={() => handleBulkStar(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb text-gray-600 dark:text-gray-300 hover:border-gray-400 transition-colors"
              >
                <StarOff className="w-4 h-4" /> Unstar all
              </button>
              <button
                onClick={() => setShowBinderPicker(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb text-gray-600 dark:text-gray-300 hover:border-dbb-accent hover:text-dbb-accent transition-colors"
              >
                <FolderOpen className="w-4 h-4" /> Move to binder
              </button>
              <button
                onClick={() => setShowListPicker(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb text-gray-600 dark:text-gray-300 hover:border-green-500 hover:text-green-400 transition-colors"
              >
                <Tag className="w-4 h-4" /> List on Bazaar
              </button>
              <button
                onClick={handleBulkDelete}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-red-200 dark:border-red-800 rounded-dbb text-red-600 dark:text-red-400 hover:border-red-500 hover:text-red-300 transition-colors"
              >
                <Trash2 className="w-4 h-4" /> Delete all
              </button>
              <button
                onClick={exitMultiSelect}
                className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
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
          <div className="bg-white dark:bg-dbb-primary border border-dbb-accent/30 rounded-dbb max-w-sm w-full p-6 shadow-2xl">
            {listMode === null && (
              <>
                <h3 className="text-lg font-bold mb-1">List on Bazaar</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  {selectedCount} card{selectedCount !== 1 ? 's' : ''} selected
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-3 font-medium">Sell as singles or put up for claim sale?</p>
                <div className="flex gap-3 mb-4">
                  <button
                    onClick={() => setListMode('singles')}
                    className="flex-1 py-3 border border-gray-200 dark:border-dbb-tertiary/50 hover:border-dbb-accent text-gray-600 dark:text-gray-300 hover:text-dbb-accent rounded-dbb text-sm font-medium transition-colors flex items-center justify-center gap-1.5"
                  >
                    <Tag className="w-4 h-4" /> Singles
                  </button>
                  <button
                    onClick={() => setListMode('claim')}
                    className="flex-1 py-3 border border-gray-200 dark:border-dbb-tertiary/50 hover:border-dbb-accent text-gray-600 dark:text-gray-300 hover:text-dbb-accent rounded-dbb text-sm font-medium transition-colors flex items-center justify-center gap-1.5"
                  >
                    <Package className="w-4 h-4" /> Claim Sale
                  </button>
                </div>
                <button
                  onClick={() => { setShowListPicker(false); setListMode(null) }}
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </>
            )}

            {listMode === 'singles' && (
              <>
                <h3 className="text-lg font-bold mb-1">List as Singles</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  {selectedCount} card{selectedCount !== 1 ? 's' : ''} · Price = CKD USD × multiplier
                </p>

                <p className="text-xs text-gray-600 dark:text-gray-500 mb-1.5 font-medium">Multiplier</p>
                <div className="flex gap-3 mb-4">
                  {[2.5, 2.8, 3.0].map(m => (
                    <button
                      key={m}
                      onClick={() => setListMultiplier(m)}
                      className={`flex-1 py-3 rounded-dbb border text-sm font-semibold transition-colors ${
                        listMultiplier === m
                          ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                          : 'border-gray-200 dark:border-dbb-tertiary/50 text-gray-500 dark:text-gray-400 hover:border-dbb-accent/50'
                      }`}
                    >
                      ×{m}
                    </button>
                  ))}
                </div>

                <p className="text-xs text-gray-600 dark:text-gray-500 mb-1.5 font-medium">Duration (max 24h)</p>
                <div className="flex gap-2 mb-4">
                  {[1, 3, 6, 12, 24].map(h => (
                    <button
                      key={h}
                      onClick={() => setListDuration(h)}
                      className={`flex-1 py-2 rounded-dbb border text-xs font-medium transition-colors ${
                        listDuration === h
                          ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                          : 'border-gray-200 dark:border-dbb-tertiary/50 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500'
                      }`}
                    >
                      {h}h
                    </button>
                  ))}
                </div>

                {/* Per-card quantities */}
                <div className="mb-4 max-h-40 overflow-y-auto">
                  <p className="text-xs text-gray-600 dark:text-gray-500 mb-1.5 font-medium">Quantities</p>
                  {selectedCards.map(c => (
                    <div key={c.id} className="flex items-center gap-2 py-1">
                      <span className="text-xs text-gray-600 dark:text-gray-400 flex-1 truncate">
                        {c.card_index?.name || 'Card'}{(c.foil && c.foil !== 'normal') ? ` (${c.foil})` : ''}
                      </span>
                      <input
                        type="number"
                        min="1"
                        max={c.quantity || 1}
                        value={listQuantities[c.id] ?? 1}
                        onChange={(e) => {
                          const v = Math.max(1, Math.min(c.quantity || 1, parseInt(e.target.value) || 1))
                          setListQuantities(prev => ({ ...prev, [c.id]: v }))
                        }}
                        className="w-14 text-center bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded px-1 py-0.5 text-xs focus:border-dbb-accent focus:outline-none"
                      />
                      <span className="text-[10px] text-gray-500">of {c.quantity || 1}</span>
                    </div>
                  ))}
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={handleBulkList}
                    disabled={listing}
                    className="flex-1 btn btn-primary btn-md"
                  >
                    {listing ? 'Listing...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setListMode(null)}
                    className="btn btn-secondary btn-md"
                  >
                    Back
                  </button>
                </div>
              </>
            )}

            {listMode === 'claim' && (
              <>
                <h3 className="text-lg font-bold mb-1">Claim Sale</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  {selectedCount} card{selectedCount !== 1 ? 's' : ''} in one claim sale
                </p>

                <div className="space-y-3 mb-4">
                  <input
                    type="text"
                    placeholder="Claim sale title"
                    value={csTitle}
                    onChange={(e) => setCsTitle(e.target.value)}
                    className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
                  />
                  <textarea
                    placeholder="Description (optional)"
                    value={csDescription}
                    onChange={(e) => setCsDescription(e.target.value)}
                    rows={2}
                    className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600 resize-none"
                  />
                  <input
                    type="text"
                    placeholder="Set code (optional)"
                    value={csSetCode}
                    onChange={(e) => setCsSetCode(e.target.value)}
                    className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb px-3 py-2 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
                  />

                  <div>
                    <p className="text-xs text-gray-600 dark:text-gray-500 mb-1.5 font-medium">Duration (max 24h)</p>
                    <div className="flex gap-1.5">
                      {[1, 3, 6, 12, 24].map(h => (
                        <button
                          key={h}
                          onClick={() => setListDuration(h)}
                          className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                            listDuration === h
                              ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                              : 'border-gray-200 dark:border-dbb-tertiary/50 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500'
                          }`}
                        >
                          {h}h
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs text-gray-600 dark:text-gray-500 mb-1.5 font-medium">Delivery</p>
                    <div className="flex gap-2">
                      {[
                        { value: 'pickup', label: 'Pickup' },
                        { value: 'shipping', label: 'Shipping' },
                        { value: 'both', label: 'Both' },
                      ].map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setCsDelivery(opt.value)}
                          className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                            csDelivery === opt.value
                              ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                              : 'border-gray-200 dark:border-dbb-tertiary/50 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={handleBulkList}
                    disabled={listing}
                    className="flex-1 btn btn-primary btn-md"
                  >
                    {listing ? 'Creating...' : 'Create Claim Sale'}
                  </button>
                  <button
                    onClick={() => setListMode(null)}
                    className="btn btn-secondary btn-md"
                  >
                    Back
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Guided missing-photo capture. One photo per library-card row covers
          every owned/listed copy; quantity never creates duplicate steps. */}
      {missingPhotoIds.length > 0 && (() => {
        const cardId = missingPhotoIds[photoCaptureIndex]
        const card = cards.find(c => c.id === cardId)
        const cardName = card?.card_index?.name || 'Selected card'
        return (
          <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-dbb-primary border border-dbb-accent/30 rounded-dbb max-w-md w-full p-5 shadow-2xl max-h-[95vh] overflow-y-auto">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h3 className="font-bold text-gray-900 dark:text-white">Add condition photos</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Card {photoCaptureIndex + 1} of {missingPhotoIds.length}: {cardName}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    One photo covers all copies of this card in your listing.
                  </p>
                </div>
                <button
                  onClick={() => { setMissingPhotoIds([]); setPhotoCaptureIndex(0); setShowListPicker(true) }}
                  className="p-1 text-gray-500 hover:text-gray-900 dark:hover:text-white"
                  aria-label="Close photo capture"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <CameraCapture
                libraryCardId={cardId}
                cardName={cardName}
                onCancel={() => { setMissingPhotoIds([]); setPhotoCaptureIndex(0); setShowListPicker(true) }}
                onUploaded={() => {
                  if (photoCaptureIndex + 1 < missingPhotoIds.length) {
                    setPhotoCaptureIndex(i => i + 1)
                  } else {
                    setMissingPhotoIds([])
                    setPhotoCaptureIndex(0)
                    toast('All required photos added. Resuming your listing.', 'success')
                    setTimeout(() => handleBulkList(), 0)
                  }
                }}
              />
            </div>
          </div>
        )
      })()}
    </div>
  )
}
