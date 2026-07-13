'use client'

import { useState, useEffect, useCallback } from 'react'
import { Star, Clock, MapPin, Truck, Package, Heart, Edit3, X, AlertCircle, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import ClaimSaleCard from '@/components/ClaimSaleCard'
import { useToast } from '@/components/Toast'

const DELIVERY_LABELS = {
  pickup: { icon: MapPin, label: 'Pickup available' },
  shipping: { icon: Truck, label: 'Shipping available' },
  both: { icon: Package, label: 'Pickup & shipping' },
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return null
  const now = Date.now()
  const expiry = new Date(expiresAt).getTime()
  const diff = expiry - now
  if (diff <= 0) return { text: 'Ended', expired: true }
  const hours = Math.floor(diff / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  if (hours >= 1) return { text: `${hours}h ${minutes}m left`, expired: false }
  return { text: `${minutes}m left`, expired: false }
}

function formatCreated(createdAt) {
  if (!createdAt) return ''
  const date = new Date(createdAt)
  const now = new Date()
  const diffMs = now - date
  const hours = Math.floor(diffMs / 3600000)
  const days = Math.floor(hours / 24)
  if (days >= 1) return `${days}d ago`
  if (hours >= 1) return `${hours}h ago`
  const minutes = Math.floor(diffMs / 60000)
  return `${minutes}m ago`
}

export default function ClaimSaleView({
  claimSale,
  sellerName,
  listings: initialListings,
  isFollowing: initialIsFollowing,
  followerCount: initialFollowerCount,
  isOwner,
  notFound,
  claimSaleId,
  userId,
}) {
  const [listings, setListings] = useState(initialListings || [])
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing)
  const [followerCount, setFollowerCount] = useState(initialFollowerCount || 0)
  const [followLoading, setFollowLoading] = useState(false)
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionValue, setDescriptionValue] = useState(claimSale?.description || '')
  const [savingDescription, setSavingDescription] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [expiryInfo, setExpiryInfo] = useState(() => formatExpiry(claimSale?.expires_at))
  const { toast } = useToast()

  // Live countdown
  useEffect(() => {
    if (!claimSale?.expires_at) return
    const timer = setInterval(() => {
      setExpiryInfo(formatExpiry(claimSale.expires_at))
    }, 60000) // update every minute
    return () => clearInterval(timer)
  }, [claimSale?.expires_at])

  const isExpired = claimSale?.status === 'expired' || claimSale?.status === 'cancelled' ||
    (claimSale?.expires_at && new Date(claimSale.expires_at).getTime() <= Date.now())

  const handleFollow = useCallback(async () => {
    if (!userId) {
      toast('Sign in to follow claim sales')
      return
    }
    if (isOwner) return

    setFollowLoading(true)
    try {
      if (isFollowing) {
        // Unfollow
        const res = await fetch(`/api/follows?claim_sale_id=${claimSaleId}`, { method: 'DELETE' })
        if (res.ok) {
          setIsFollowing(false)
          setFollowerCount(c => Math.max(0, c - 1))
        }
      } else {
        // Follow
        const res = await fetch('/api/follows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claim_sale_id: claimSaleId }),
        })
        if (res.ok) {
          setIsFollowing(true)
          setFollowerCount(c => c + 1)
        }
      }
    } catch {
      toast('Failed to update follow status')
    } finally {
      setFollowLoading(false)
    }
  }, [userId, isOwner, isFollowing, claimSaleId, toast])

  const handleSaveDescription = useCallback(async () => {
    setSavingDescription(true)
    try {
      const res = await fetch(`/api/claim-sales/${claimSaleId}/edit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: descriptionValue }),
      })
      if (res.ok) {
        toast('Description updated')
        setEditingDescription(false)
      } else {
        toast('Failed to update description')
      }
    } catch {
      toast('Failed to update description')
    } finally {
      setSavingDescription(false)
    }
  }, [claimSaleId, descriptionValue, toast])

  const handleCancel = useCallback(async () => {
    if (!confirm('Cancel this claim sale? This cannot be undone.')) return
    setCancelling(true)
    try {
      const res = await fetch(`/api/claim-sales/${claimSaleId}/cancel`, { method: 'POST' })
      if (res.ok) {
        toast('Claim sale cancelled')
        // Refresh page to reflect cancelled state
        window.location.reload()
      } else {
        toast('Failed to cancel claim sale')
      }
    } catch {
      toast('Failed to cancel claim sale')
    } finally {
      setCancelling(false)
    }
  }, [claimSaleId, toast])

  // Not found state
  if (notFound || !claimSale) {
    return (
      <div className="container mx-auto px-4 py-12 max-w-2xl">
        <div className="text-center space-y-4">
          <AlertCircle size={48} className="mx-auto text-gray-400" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Claim sale not found</h1>
          <p className="text-gray-500 dark:text-gray-400">
            This claim sale may have been removed or the link is incorrect.
          </p>
          <Link href="/bazaar" className="btn btn-primary btn-md inline-flex">
            Browse the Bazaar
          </Link>
        </div>
      </div>
    )
  }

  const delivery = DELIVERY_LABELS[claimSale.delivery_option] || DELIVERY_LABELS.both
  const DeliveryIcon = delivery.icon
  const totalCards = listings.length

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      {/* Back link */}
      <Link
        href="/bazaar"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-dbb-accent transition-colors mb-4"
      >
        <ArrowLeft size={16} />
        Back to Bazaar
      </Link>

      {/* Expired/Cancelled banner */}
      {isExpired && (
        <div className="mb-4 rounded-dbb border border-gray-300 dark:border-dbb-tertiary bg-gray-100 dark:bg-dbb-secondary px-4 py-3 flex items-center gap-2 text-gray-700 dark:text-gray-300">
          <AlertCircle size={18} />
          <span className="font-medium">
            {claimSale.status === 'cancelled' ? 'This claim sale has been cancelled.' : 'This claim sale has ended.'}
          </span>
        </div>
      )}

      {/* Header section */}
      <div className="rounded-dbb bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/40 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
              {claimSale.title}
            </h1>
            {claimSale.description && !editingDescription && (
              <p className="text-gray-600 dark:text-gray-400 text-sm mt-2 whitespace-pre-wrap">
                {claimSale.description}
              </p>
            )}
            {/* Owner editing description */}
            {isOwner && !isExpired && editingDescription && (
              <div className="mt-2 space-y-2">
                <textarea
                  value={descriptionValue}
                  onChange={(e) => setDescriptionValue(e.target.value)}
                  className="w-full rounded-dbb border border-gray-300 dark:border-dbb-tertiary bg-white dark:bg-dbb-primary px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-dbb-accent"
                  rows={3}
                  placeholder="Add a description..."
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveDescription}
                    disabled={savingDescription}
                    className="btn btn-primary btn-sm"
                  >
                    {savingDescription ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => {
                      setEditingDescription(false)
                      setDescriptionValue(claimSale.description || '')
                    }}
                    className="btn btn-secondary btn-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {isOwner && !isExpired && !editingDescription && (
              <button
                onClick={() => setEditingDescription(true)}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-dbb-accent transition-colors mt-2"
              >
                <Edit3 size={12} />
                Edit description
              </button>
            )}

            {/* Meta info row */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-xs text-gray-500 dark:text-gray-400">
              {sellerName && (
                <span>
                  by <span className="font-medium text-gray-700 dark:text-gray-300">{sellerName}</span>
                </span>
              )}
              {claimSale.set_code && (
                <span className="uppercase">{claimSale.set_code}</span>
              )}
              <span>{formatCreated(claimSale.created_at)}</span>
              <span className="flex items-center gap-1">
                <Clock size={12} />
                {expiryInfo?.text || '—'}
              </span>
              <span className="flex items-center gap-1">
                <DeliveryIcon size={12} />
                {delivery.label}
              </span>
              <span>{totalCards} {totalCards === 1 ? 'card' : 'cards'}</span>
            </div>
          </div>

          {/* Actions column */}
          <div className="flex flex-col items-stretch sm:items-end gap-2 shrink-0">
            {/* Follow button (not owner) */}
            {!isOwner && (
              <button
                onClick={handleFollow}
                disabled={followLoading}
                className={`btn btn-sm ${isFollowing ? 'btn-secondary' : 'btn-outline'}`}
              >
                <Star
                  size={14}
                  fill={isFollowing ? 'currentColor' : 'none'}
                  className={isFollowing ? 'text-dbb-accent' : ''}
                />
                {isFollowing ? 'Following' : 'Follow'}
                {followerCount > 0 && (
                  <span className="ml-1 text-xs opacity-70">({followerCount})</span>
                )}
              </button>
            )}

            {/* Follower count (owner view) */}
            {isOwner && followerCount > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <Star size={12} />
                {followerCount} {followerCount === 1 ? 'follower' : 'followers'}
              </div>
            )}

            {/* Owner management actions */}
            {isOwner && !isExpired && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="btn btn-danger btn-sm"
              >
                {cancelling ? 'Cancelling...' : 'Cancel sale'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Card grid */}
      {totalCards === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400">No cards in this claim sale.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {listings.map((listing) => (
            <ClaimSaleCard key={listing.id} listing={listing} />
          ))}
        </div>
      )}
    </div>
  )
}