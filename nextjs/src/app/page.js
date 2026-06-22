'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase, cardQueries, priceUtils, generateCaption } from '../lib/supabase'
import Sidebar from '../components/Sidebar'
import CardGrid from '../components/CardGrid'
import CardDetail from '../components/CardDetail'
import LoadingSkeleton from '../components/LoadingSkeleton'
import { Filter, Grid, X } from 'lucide-react'

export default function Home() {
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedCard, setSelectedCard] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [filters, setFilters] = useState({
    setCode: null,
    rarity: null,
    colors: [],
    cardType: null,
    minPrice: null,
    maxPrice: null,
    isFoil: undefined,
  })
  const [filterOptions, setFilterOptions] = useState({
    sets: [],
    rarities: [],
    cardTypes: [],
  })
  // Pagination state
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const PAGE_SIZE = 24

  // Load filter options
  useEffect(() => {
    const loadFilterOptions = async () => {
      try {
        const options = await cardQueries.getFilterOptions()
        setFilterOptions(options)
      } catch (err) {
        console.error('Failed to load filter options:', err)
      }
    }
    loadFilterOptions()
  }, [])

  // Load cards with filters (initial load)
  const loadCards = useCallback(async () => {
    setLoading(true)
    setError(null)
    setPage(1) // Reset to first page when filters change
    
    try {
      const result = await cardQueries.getAvailableCards(filters, 1, PAGE_SIZE)
      
      if (result.error) {
        throw result.error
      }
      
      setCards(result.data || [])
      setHasMore(result.data?.length === PAGE_SIZE) // More cards available if we got a full page
    } catch (err) {
      console.error('Failed to load cards:', err)
      setError('Failed to load cards. Please check your connection.')
    } finally {
      setLoading(false)
    }
  }, [filters])

  // Load more cards (for infinite scroll)
  const loadMoreCards = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return
    
    setLoadingMore(true)
    
    try {
      const nextPage = page + 1
      const result = await cardQueries.getAvailableCards(filters, nextPage, PAGE_SIZE)
      
      if (result.error) {
        throw result.error
      }
      
      if (result.data && result.data.length > 0) {
        setCards(prev => [...prev, ...result.data])
        setPage(nextPage)
        setHasMore(result.data.length === PAGE_SIZE) // More cards available if we got a full page
      } else {
        setHasMore(false) // No more cards
      }
    } catch (err) {
      console.error('Failed to load more cards:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [filters, page, hasMore, loading, loadingMore])

  // Infinite scroll hook
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMore && hasMore) {
          loadMoreCards()
        }
      },
      { threshold: 0.5, rootMargin: '200px' }
    )

    const sentinel = document.getElementById('scroll-sentinel')
    if (sentinel) observer.observe(sentinel)

    return () => observer.disconnect()
  }, [loadingMore, hasMore, loadMoreCards])

  // Initial load and filter changes
  useEffect(() => {
    loadCards()
  }, [loadCards])

  // Handle filter changes
  const updateFilter = (key, value) => {
    setFilters(prev => ({
      ...prev,
      [key]: value,
    }))
  }

  // Clear all filters
  const clearFilters = () => {
    setFilters({
      setCode: null,
      rarity: null,
      colors: [],
      cardType: null,
      minPrice: null,
      maxPrice: null,
      isFoil: undefined,
    })
  }

  // Handle card selection
  const handleCardClick = (card) => {
    setSelectedCard(card)
  }

  // Close card detail
  const closeCardDetail = () => {
    setSelectedCard(null)
  }

  // Copy caption to clipboard
  const copyCaption = async (card, multiplier) => {
    try {
      const caption = generateCaption(card, multiplier)
      await navigator.clipboard.writeText(caption)
      
      // Show toast notification
      const toast = document.createElement('div')
      toast.className = 'toast fixed bottom-4 right-4 bg-dbb-accent text-white px-6 py-3 rounded-lg shadow-lg z-50'
      toast.textContent = 'Caption copied!'
      document.body.appendChild(toast)
      
      setTimeout(() => toast.remove(), 2000)
    } catch (err) {
      console.error('Failed to copy caption:', err)
    }
  }

  // Check if any filters are active
  const hasActiveFilters = Object.values(filters).some(v => 
    v !== null && v !== undefined && (Array.isArray(v) ? v.length > 0 : true)
  )

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-dbb-primary/95 backdrop-blur border-b border-dbb-accent/20">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="lg:hidden p-2 hover:bg-dbb-secondary rounded-lg transition-colors"
              >
                <Filter className="w-6 h-6" />
              </button>
              <h1 className="text-2xl font-bold text-dbb-accent">
                MTG Bazaar
              </h1>
              <span className="text-sm text-gray-400 hidden sm:inline">
                Magic: The Gathering Claim Sales
              </span>
            </div>
            
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-2 text-sm text-dbb-accent hover:text-red-400 transition-colors"
              >
                <X className="w-4 h-4" />
                Clear Filters
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar - Desktop */}
        <aside className="hidden lg:block w-72 fixed left-0 top-[73px] bottom-0 overflow-y-auto border-r border-dbb-accent/10 bg-dbb-primary/50">
          <Sidebar
            filters={filters}
            updateFilter={updateFilter}
            clearFilters={clearFilters}
            filterOptions={filterOptions}
          />
        </aside>

        {/* Sidebar - Mobile Overlay */}
        {sidebarOpen && (
          <>
            <div
              className="fixed inset-0 bg-black/50 z-40 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
            <aside className="fixed left-0 top-0 bottom-0 w-80 z-50 lg:hidden sidebar-transition">
              <div className="h-full bg-dbb-primary overflow-y-auto">
                <div className="p-4 border-b border-dbb-accent/10 flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Filters</h2>
                  <button
                    onClick={() => setSidebarOpen(false)}
                    className="p-2 hover:bg-dbb-secondary rounded-lg"
                  >
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
          {loading ? (
            <LoadingSkeleton count={12} />
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-red-400 mb-4">{error}</p>
              <button onClick={loadCards} className="btn-primary">
                Try Again
              </button>
            </div>
          ) : cards.length === 0 ? (
            <div className="text-center py-12">
              <Grid className="w-16 h-16 mx-auto mb-4 text-gray-600" />
              <h2 className="text-xl font-semibold mb-2">No Cards Found</h2>
              <p className="text-gray-400 mb-4">
                Try adjusting your filters or check back later for new arrivals.
              </p>
              {hasActiveFilters && (
                <button onClick={clearFilters} className="btn-primary">
                  Clear All Filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm text-gray-400">
                  Showing {cards.length} card{cards.length !== 1 ? 's' : ''}
                </p>
                {hasMore && (
                  <p className="text-xs text-gray-500">Scroll for more</p>
                )}
              </div>
              <CardGrid 
                cards={cards} 
                onCardClick={handleCardClick}
              />
              {/* Scroll sentinel for infinite scroll */}
              <div id="scroll-sentinel" className="h-20 flex items-center justify-center py-4">
                {loadingMore && (
                  <div className="text-gray-400 text-sm">Loading more cards...</div>
                )}
                {!hasMore && cards.length > 0 && (
                  <div className="text-gray-500 text-sm">No more cards</div>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* Card Detail Modal */}
      {selectedCard && (
        <CardDetail
          card={selectedCard}
          onClose={closeCardDetail}
          onCopyCaption={copyCaption}
        />
      )}
    </div>
  )
}
