'use client'

import { useState, useEffect, useCallback } from 'react'
import { Star, User, Trash2, Loader2, Clock, Grid, Link as LinkIcon } from 'lucide-react'
import Link from 'next/link'

function formatExpiry(expiresAt) {
  if (!expiresAt) return '—'
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Ended'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h >= 1) return `${h}h ${m}m left`
  return `${m}m left`
}

export default function FollowingSection() {
  const [followedSales, setFollowedSales] = useState([])
  const [followedUsers, setFollowedUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [unfollowingId, setUnfollowingId] = useState(null)

  const loadFollows = useCallback(async () => {
    try {
      const res = await fetch('/api/follows')
      if (!res.ok) return
      const data = await res.json()
      setFollowedSales(data.claim_sales || [])
      setFollowedUsers(data.users || [])
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadFollows() }, [loadFollows])

  const handleUnfollowSale = async (csId) => {
    setUnfollowingId(csId)
    try {
      const res = await fetch(`/api/follows?claim_sale_id=${csId}`, { method: 'DELETE' })
      if (res.ok) {
        setFollowedSales(prev => prev.filter(cs => cs.id !== csId))
      }
    } catch {
      // silent
    } finally {
      setUnfollowingId(null)
    }
  }

  const handleUnfollowUser = async (userId) => {
    setUnfollowingId(userId)
    try {
      const res = await fetch(`/api/follows?followee_id=${userId}`, { method: 'DELETE' })
      if (res.ok) {
        setFollowedUsers(prev => prev.filter(u => u.id !== userId))
      }
    } catch {
      // silent
    } finally {
      setUnfollowingId(null)
    }
  }

  if (loading) {
    return (
      <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Following</h3>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      </div>
    )
  }

  const hasContent = followedSales.length > 0 || followedUsers.length > 0

  return (
    <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
      <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Following</h3>

      {!hasContent ? (
        <div className="text-center py-6">
          <Star className="w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">You&apos;re not following anything yet.</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            <Link href="/bazaar" className="text-dbb-accent hover:underline">Browse the Bazaar</Link>
            {' '}and star claim sales or sellers to track them here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Followed claim sales */}
          {followedSales.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1">
                <Star className="w-3.5 h-3.5" />
                Claim Sales ({followedSales.length})
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {followedSales.map(cs => (
                  <div
                    key={cs.id}
                    className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-dbb-primary/50 rounded-lg border border-gray-200 dark:border-dbb-tertiary/30"
                  >
                    <Link href={`/claim-sales/${cs.id}`} className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate hover:text-dbb-accent transition-colors">
                        {cs.title || 'Untitled sale'}
                      </p>
                      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {cs.seller_name && (
                          <span>by {cs.seller_name}</span>
                        )}
                        <span className={`flex items-center gap-0.5 ${formatExpiry(cs.expires_at) === 'Ended' ? 'text-red-500' : ''}`}>
                          <Clock className="w-3 h-3" />
                          {formatExpiry(cs.expires_at)}
                        </span>
                        {cs.set_code && (
                          <span className="uppercase">{cs.set_code}</span>
                        )}
                      </div>
                    </Link>
                    <button
                      onClick={() => handleUnfollowSale(cs.id)}
                      disabled={unfollowingId === cs.id}
                      className="flex-shrink-0 p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title="Unfollow"
                    >
                      {unfollowingId === cs.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Followed users */}
          {followedUsers.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1">
                <User className="w-3.5 h-3.5" />
                Sellers ({followedUsers.length})
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {followedUsers.map(u => (
                  <div
                    key={u.id}
                    className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-dbb-primary/50 rounded-lg border border-gray-200 dark:border-dbb-tertiary/30"
                  >
                    <div className="w-8 h-8 bg-dbb-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-dbb-accent" />
                    </div>
                    <span className="flex-1 text-sm font-medium text-gray-900 dark:text-white truncate">
                      {u.display_name || 'Unknown seller'}
                    </span>
                    <button
                      onClick={() => handleUnfollowUser(u.id)}
                      disabled={unfollowingId === u.id}
                      className="flex-shrink-0 p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title="Unfollow"
                    >
                      {unfollowingId === u.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}