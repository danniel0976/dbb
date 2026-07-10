'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import LibraryCard from '@/components/LibraryCard'
import CardDetailModal from '@/components/CardDetailModal'
import { useToast } from '@/components/Toast'
import { Search, SortAsc } from 'lucide-react'
import Link from 'next/link'

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'set', label: 'Set / Number' },
  { value: 'cmc', label: 'Mana value' },
  { value: 'rarity', label: 'Rarity' },
]

export default function LibraryView({ userId, initialData }) {
  const { toast } = useToast()
  const [cards, setCards] = useState(initialData?.cards || [])
  const [total, setTotal] = useState(initialData?.total || 0)
  const [hasMore, setHasMore] = useState(initialData?.hasMore || false)
  const [page, setPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sort, setSort] = useState('newest')
  const [q, setQ] = useState('')
  const [selectedCard, setSelectedCard] = useState(null)

  const sentinelRef = useRef(null)
  const searchTimeout = useRef(null)
  const currentSort = useRef(sort)
  const currentQ = useRef(q)
  const resetPending = useRef(false)

  // Reload from page 1 when sort/search changes
  const reload = useCallback(async (newSort, newQ) => {
    resetPending.current = true
    try {
      const params = new URLSearchParams({ page: '1', sort: newSort, q: newQ })
      const res = await fetch(`/api/library?${params}`)
      if (!res.ok) return
      const data = await res.json()
      setCards(data.cards || [])
      setTotal(data.total || 0)
      setHasMore(data.hasMore || false)
      setPage(1)
    } catch {
      toast('Failed to load library', 'error')
    } finally {
      resetPending.current = false
    }
  }, [toast])

  const handleSortChange = (newSort) => {
    setSort(newSort)
    currentSort.current = newSort
    reload(newSort, currentQ.current)
  }

  const handleSearchChange = (newQ) => {
    setQ(newQ)
    currentQ.current = newQ
    clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      reload(currentSort.current, newQ)
    }, 300)
  }

  // Load next page
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || resetPending.current) return
    setLoadingMore(true)
    try {
      const nextPage = page + 1
      const params = new URLSearchParams({ page: String(nextPage), sort: currentSort.current, q: currentQ.current })
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
  }, [loadingMore, hasMore, page, toast])

  // Infinite scroll observer
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore()
      },
      { rootMargin: '300px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore])

  // Card actions
  const handleStar = useCallback(async (libraryRow) => {
    const newStarred = !libraryRow.starred
    // Optimistic update
    setCards(prev => prev.map(c => c.id === libraryRow.id ? { ...c, starred: newStarred } : c))
    try {
      const res = await fetch(`/api/library/${libraryRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starred: newStarred }),
      })
      if (!res.ok) throw new Error()
    } catch {
      // Revert
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

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
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
        <div className="text-sm text-gray-500 ml-auto">
          {total} card{total !== 1 ? 's' : ''}
        </div>
        <button className="px-3 py-2 text-sm border border-gray-700 rounded-lg text-gray-400 hover:border-dbb-accent/50 transition-colors">
          Filters
        </button>
      </div>

      {/* Grid */}
      {cards.length === 0 ? (
        <div className="text-center py-24">
          <div className="text-5xl mb-4">📦</div>
          <h2 className="text-xl font-semibold mb-2 text-gray-300">Your library is empty</h2>
          <p className="text-gray-500 mb-6">Import your ManaBox collection to get started.</p>
          <Link
            href="/import"
            className="inline-block btn-primary px-6 py-2 rounded-lg"
          >
            Import your ManaBox collection →
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {cards.map(card => (
              <LibraryCard
                key={card.id}
                libraryRow={card}
                onStar={handleStar}
                onDelete={handleDelete}
                onOpen={setSelectedCard}
              />
            ))}
          </div>

          {/* Infinite scroll sentinel */}
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

      {/* Card detail modal */}
      {selectedCard && (
        <CardDetailModal
          libraryRow={selectedCard}
          onClose={() => setSelectedCard(null)}
          onSave={handleSaveFromModal}
          onDelete={handleDeleteFromModal}
        />
      )}
    </div>
  )
}
