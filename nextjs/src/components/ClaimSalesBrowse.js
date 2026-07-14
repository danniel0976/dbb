'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Flame, Clock, Star, Grid, Loader2 } from 'lucide-react'
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

function ClaimSaleTile({ cs, onToggleFollow, userId }) {
  const [following, setFollowing] = useState(false)
  const [followCount, setFollowCount] = useState(cs.follower_count || 0)
  const [followLoading, setFollowLoading] = useState(false)

  // Check initial follow state
  useEffect(() => {
    if (!userId) return
    fetch(`/api/follows?check=${cs.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.following) setFollowing(true) })
      .catch(() => {})
  }, [userId, cs.id])

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
        }
      }
    } catch {
      // silent
    } finally {
      setFollowLoading(false)
    }
  }

  return (
    <Link
      href={`/claim-sales/${cs.id}`}
      className="group relative bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/40 rounded-dbb overflow-hidden card-hover"
    >
      {/* Header */}
      <div className="p-3 border-b border-gray-200 dark:border-dbb-tertiary/30">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {cs.title}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {cs.seller_name || 'Unknown seller'}
            </p>
          </div>
          <button
            onClick={handleFollow}
            disabled={followLoading || !userId}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded-dbb border transition-colors flex-shrink-0 ${
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
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <span className="flex items-center gap-1">
            <Grid className="w-3.5 h-3.5" />
            {cs.card_count || 0} card{(cs.card_count || 0) !== 1 ? 's' : ''}
          </span>
          <span className={`flex items-center gap-1 ${formatExpiry(cs.expires_at) === 'Ended' ? 'text-red-500' : ''}`}>
            <Clock className="w-3.5 h-3.5" />
            {formatExpiry(cs.expires_at)}
          </span>
        </div>

        {cs.description && (
          <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
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

export default function ClaimSalesBrowse({ userId }) {
  const [section, setSection] = useState('hot') // 'hot' | 'ending_soon'
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const reqGenRef = useRef(0)

  const loadSales = useCallback(async (sortKey, p = 1) => {
    const gen = ++reqGenRef.current
    if (p === 1) {
      setLoading(true)
      setError(null)
    } else {
      setLoadingMore(true)
    }
    const controller = new AbortController()
    try {
      const res = await fetch(`/api/claim-sales?sort=${sortKey}&page=${p}`, { signal: controller.signal })
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

  useEffect(() => {
    loadSales(section === 'hot' ? 'most_followed' : 'ending_soon', 1)
  }, [section, loadSales])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return
    loadSales(section === 'hot' ? 'most_followed' : 'ending_soon', page + 1)
  }, [loadingMore, hasMore, page, section, loadSales])

  return (
    <div className="flex-1 lg:ml-72 p-4 lg:p-6">
      {/* Section toggle */}
      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => setSection('hot')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-dbb text-sm font-medium transition-colors ${
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
          className={`flex items-center gap-1.5 px-4 py-2 rounded-dbb text-sm font-medium transition-colors ${
            section === 'ending_soon'
              ? 'bg-dbb-accent text-white'
              : 'bg-white dark:bg-dbb-secondary text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-dbb-tertiary/40 hover:border-dbb-accent/50'
          }`}
        >
          <Clock className="w-4 h-4" />
          Ending Soon
        </button>
        {!loading && total > 0 && (
          <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
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
            onClick={() => loadSales(section === 'hot' ? 'most_followed' : 'ending_soon', 1)}
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
              <ClaimSaleTile key={cs.id} cs={cs} userId={userId} />
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