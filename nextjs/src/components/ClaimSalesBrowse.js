'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Flame, Clock, Star, Grid, Loader2, Search, X } from 'lucide-react'
import Link from 'next/link'
import LoadingSkeleton from '@/components/LoadingSkeleton'

const PAGE_SIZE = 20

function formatExpiry(expiresAt) {
  if (!expiresAt) return '—'
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Ended'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h >= 1) return `${h}h ${m}m left`
  return `${m}m left`
}

function useExpiryCountdown(expiresAt) {
  const [text, setText] = useState(() => formatExpiry(expiresAt))
  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => {
      setText(formatExpiry(expiresAt))
    }, 60000) // tick every minute
    return () => clearInterval(timer)
  }, [expiresAt])
  return text
}

function ClaimSaleTile({ cs, userId, isFollowed, onToggleFollow }) {
  const [following, setFollowing] = useState(isFollowed)
  const [followCount, setFollowCount] = useState(cs.follower_count || 0)
  const [followLoading, setFollowLoading] = useState(false)
  const expiryText = useExpiryCountdown(cs.expires_at)
  const [thumbUrl, setThumbUrl] = useState(null)

  // Sync follow state when parent batch data updates
  useEffect(() => {
    setFollowing(isFollowed)
  }, [isFollowed])

  // Fetch first card's thumbnail from Scryfall (one request per tile, cached in sessionStorage)
  useEffect(() => {
    if (!cs.first_card_scryfall_id) return
    const cacheKey = `sf_img_${cs.first_card_scryfall_id}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) { setThumbUrl(cached); return }

    let cancelled = false
    fetch(`https://api.scryfall.com/cards/${cs.first_card_scryfall_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || cancelled) return
        const url = data.image_uris?.small || data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.small
        if (url) {
          sessionStorage.setItem(cacheKey, url)
          setThumbUrl(url)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [cs.first_card_scryfall_id])

  const handleFollow = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!userId) return
    setFollowLoading(true)
    try {
      if (following) {
        const res = await fetch(`/api/follows?claim_sale_id=${cs.id}`, { method: 'DELETE' })
        if (res.ok) {
          setFollowing(false)
          setFollowCount(c => Math.max(0, c - 1))
          onToggleFollow?.(cs.id, false)
        }
      } else {
        const res = await fetch('/api/follows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claim_sale_id: cs.id }),
        })
        if (res.ok) {
          setFollowing(true)
          setFollowCount(c => c + 1)
          onToggleFollow?.(cs.id, true)
        }
      }
    } catch {
      // silent
    } finally {
      setFollowLoading(false)
    }
  }

  const isEnding = expiryText === 'Ended'

  return (
    <Link
      href={`/claim-sales/${cs.id}`}
      className="group relative bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/40 rounded-dbb overflow-hidden card-hover"
    >
      {/* Card thumbnail (if available) */}
      {thumbUrl && (
        <div className="relative h-32 overflow-hidden bg-gray-100 dark:bg-dbb-primary">
          <img
            src={thumbUrl}
            alt=""
            className="w-full h-full object-contain opacity-60 group-hover:opacity-80 transition-opacity"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-white dark:from-dbb-secondary to-transparent" />
        </div>
      )}

      {/* Header */}
      <div className="p-3 border-b border-gray-200 dark:border-dbb-tertiary/30">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-dbb-sm font-semibold text-gray-900 dark:text-white truncate">
              {cs.title}
            </h3>
            <p className="text-dbb-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {cs.seller_name || 'Unknown seller'}
            </p>
          </div>
          <button
            onClick={handleFollow}
            disabled={followLoading || !userId}
            className={`flex items-center gap-1 text-dbb-xs px-2 py-1 rounded-dbb border transition-colors flex-shrink-0 ${
              following
                ? 'bg-dbb-accent/10 text-dbb-accent border-dbb-accent/30'
                : 'text-gray-500 dark:text-gray-400 border-gray-200 dark:border-dbb-tertiary/40 hover:border-dbb-accent/50 hover:text-dbb-accent'
            } ${!userId ? 'opacity-50 cursor-not-allowed' : ''}`}
            title={userId ? (following ? 'Unfollow' : 'Follow') : 'Sign in to follow'}
          >
            <Star className={`w-3.5 h-3.5 ${following ? 'fill-current' : ''}`} />
            <span className="font-medium">{followCount}</span>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-3 text-dbb-xs text-gray-500 dark:text-gray-400">
          <span className="flex items-center gap-1">
            <Grid className="w-3.5 h-3.5" />
            {cs.card_count || 0} card{(cs.card_count || 0) !== 1 ? 's' : ''}
          </span>
          <span className={`flex items-center gap-1 ${isEnding ? 'text-red-500' : ''}`}>
            <Clock className="w-3.5 h-3.5" />
            {expiryText}
          </span>
        </div>

        {cs.description && (
          <p className="text-dbb-xs text-gray-500 dark:text-gray-400 line-clamp-2">
            {cs.description}
          </p>
        )}

        {cs.set_code && (
          <span className="inline-block text-[10px] text-gray-500 dark:text-gray-500 bg-gray-100 dark:bg-dbb-primary px-1.5 py-0.5 rounded">
            {cs.set_code.toUpperCase()}
          </span>
        )}
      </div>
    </Link>
  )
}

// Parse/serialize this view's URL state. Scoped param names (cs_*) avoid
// colliding with BazaarView's own `search`/`sort` params if Bazaar URL state
// is added later; reusing Library's "one parser, reload reconstructs the
// same query" pattern (Phase 41 P0-2) so a copied/reloaded/back-navigated
// Claim Sales URL restores the same section and search text.
function parseClaimSalesQueryState(sp) {
  const section = sp.get('cs_section')
  return {
    section: section === 'ending_soon' ? 'ending_soon' : 'hot',
    q: sp.get('cs_q') || '',
  }
}

function serializeClaimSalesQueryState(section, q) {
  const params = new URLSearchParams()
  if (section && section !== 'hot') params.set('cs_section', section)
  if (q) params.set('cs_q', q)
  return params
}

export default function ClaimSalesBrowse({ userId }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialState = parseClaimSalesQueryState(searchParams)

  const [section, setSection] = useState(initialState.section) // 'hot' | 'ending_soon'
  const [q, setQ] = useState(initialState.q)
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [followedIds, setFollowedIds] = useState(new Set())
  const reqGenRef = useRef(0)
  const abortRef = useRef(null)
  const currentSection = useRef(section)
  const currentQ = useRef(q)
  const searchTimeout = useRef(null)

  const pushUrl = useCallback((overrides = {}) => {
    const nextSection = overrides.section ?? currentSection.current
    const nextQ = overrides.q ?? currentQ.current
    const params = new URLSearchParams(searchParams.toString())
    const csParams = serializeClaimSalesQueryState(nextSection, nextQ)
    params.delete('cs_section')
    params.delete('cs_q')
    for (const [k, v] of csParams) params.set(k, v)
    router.replace(`?${params}`, { scroll: false })
  }, [router, searchParams])

  const loadSales = useCallback(async (sortKey, p = 1, searchText = currentQ.current) => {
    const gen = ++reqGenRef.current
    // Abort any in-flight request
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    if (p === 1) {
      setLoading(true)
      setError(null)
    } else {
      setLoadingMore(true)
    }
    try {
      const params = new URLSearchParams({ sort: sortKey, page: String(p) })
      if (searchText) params.set('search', searchText)
      const res = await fetch(`/api/claim-sales?${params}`, { signal: controller.signal })
      if (gen !== reqGenRef.current) return // stale response
      if (!res.ok) throw new Error('Failed to load')
      const data = await res.json()
      if (gen !== reqGenRef.current) return
      if (p === 1) {
        setSales(data.claim_sales || [])
      } else {
        setSales(prev => [...prev, ...(data.claim_sales || [])])
      }
      setTotal(data.total || 0)
      setHasMore(data.hasMore || false)
      setPage(p)
    } catch (err) {
      if (err?.name === 'AbortError') return
      if (gen !== reqGenRef.current) return
      if (p === 1) setError('Failed to load claim sales')
    } finally {
      if (gen === reqGenRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [])

  const sortKeyFor = (s) => (s === 'hot' ? 'most_followed' : 'ending_soon')

  const handleSectionChange = (nextSection) => {
    setSection(nextSection)
    currentSection.current = nextSection
    pushUrl({ section: nextSection })
  }

  const handleSearchChange = (nextQ) => {
    setQ(nextQ)
    currentQ.current = nextQ
    pushUrl({ q: nextQ })
    clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      loadSales(sortKeyFor(currentSection.current), 1, nextQ)
    }, 300)
  }

  // Reconstruct state from the URL on Back/Forward navigation, mirroring
  // LibraryView's popstate sync so a copied/reloaded/back-navigated URL
  // reruns the same section + search rather than silently diverging.
  const isFirstUrlSync = useRef(true)
  useEffect(() => {
    if (isFirstUrlSync.current) {
      isFirstUrlSync.current = false
      return
    }
    const parsed = parseClaimSalesQueryState(searchParams)
    if (parsed.section === currentSection.current && parsed.q === currentQ.current) return
    setSection(parsed.section)
    setQ(parsed.q)
    currentSection.current = parsed.section
    currentQ.current = parsed.q
    loadSales(sortKeyFor(parsed.section), 1, parsed.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Batch fetch follow state once per page load (not per tile)
  useEffect(() => {
    if (!userId || sales.length === 0) return
    const ids = sales.map(cs => cs.id).join(',')
    let cancelled = false
    fetch(`/api/follows?ids=${ids}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data?.followed_ids) return
        setFollowedIds(new Set(data.followed_ids))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [userId, sales])

  useEffect(() => {
    loadSales(section === 'hot' ? 'most_followed' : 'ending_soon', 1)
    return () => {
      // Abort in-flight request on unmount/section change
      if (abortRef.current) abortRef.current.abort()
    }
  }, [section, loadSales])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return
    loadSales(sortKeyFor(section), page + 1)
  }, [loadingMore, hasMore, page, section, loadSales])

  const handleToggleFollow = useCallback((csId, isFollowing) => {
    setFollowedIds(prev => {
      const next = new Set(prev)
      if (isFollowing) next.add(csId)
      else next.delete(csId)
      return next
    })
  }, [])

  return (
    <div className="flex-1 lg:ml-72 p-4 lg:p-6">
      {/* Section toggle + search */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setSection('hot')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-dbb text-dbb-sm font-medium transition-colors ${
            section === 'hot'
              ? 'bg-dbb-accent text-white'
              : 'bg-white dark:bg-dbb-secondary text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-dbb-tertiary/40 hover:border-dbb-accent/50'
          }`}
        >
          <Flame className="w-4 h-4" />
          Hot
        </button>
        <button
          onClick={() => setSection('ending_soon')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-dbb text-dbb-sm font-medium transition-colors ${
            section === 'ending_soon'
              ? 'bg-dbb-accent text-white'
              : 'bg-white dark:bg-dbb-secondary text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-dbb-tertiary/40 hover:border-dbb-accent/50'
          }`}
        >
          <Clock className="w-4 h-4" />
          Ending Soon
        </button>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search claim sales..."
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-40 sm:w-64 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/50 rounded-dbb pl-9 pr-8 py-2 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-500"
          />
          {q && (
            <button
              onClick={() => handleSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:text-red-400 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {!loading && total > 0 && (
          <span className="text-dbb-sm text-gray-500 dark:text-gray-400 ml-2">
            {total} claim sale{total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {loading ? (
        <LoadingSkeleton count={6} />
      ) : error ? (
        <div className="text-center py-12">
          <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
          <button
            onClick={() => loadSales(sortKeyFor(section), 1)}
            className="btn btn-primary btn-md"
          >
            Try Again
          </button>
        </div>
      ) : sales.length === 0 ? (
        <div className="text-center py-16">
          <Grid className="w-16 h-16 mx-auto mb-4 text-gray-600" />
          <h2 className="text-xl font-semibold mb-2">
            {section === 'hot' ? 'No hot claim sales yet' : 'No claim sales ending soon'}
          </h2>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            {section === 'hot'
              ? 'Claim sales with the most follows will appear here.'
              : 'Claim sales closest to expiry will appear here.'}
          </p>
          <a href="/library" className="btn btn-primary btn-md inline-block">
            Create a claim sale →
          </a>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {sales.map(cs => (
              <ClaimSaleTile
                key={cs.id}
                cs={cs}
                userId={userId}
                isFollowed={followedIds.has(cs.id)}
                onToggleFollow={handleToggleFollow}
              />
            ))}
          </div>
          {hasMore && (
            <div className="mt-6 flex items-center justify-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="btn btn-primary btn-md"
              >
                {loadingMore ? (
                  <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading more...</>
                ) : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}