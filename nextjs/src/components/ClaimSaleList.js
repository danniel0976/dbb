'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Star, Clock, MapPin, Truck, Package, AlertCircle } from 'lucide-react'

const DELIVERY_LABELS = {
  pickup: { icon: MapPin, label: 'Pickup' },
  shipping: { icon: Truck, label: 'Shipping' },
  both: { icon: Package, label: 'Pickup & Shipping' },
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return '—'
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Ended'
  const hours = Math.floor(diff / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  if (hours >= 1) return `${hours}h ${minutes}m left`
  return `${minutes}m left`
}

export default function ClaimSaleList({ claimSales: initial, hasMore, total }) {
  const [claimSales] = useState(initial || [])

  if (claimSales.length === 0) {
    return (
      <div className="container mx-auto px-4 py-12 max-w-2xl">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Claim Sales</h1>
        <div className="text-center py-12 rounded-dbb bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/40">
          <AlertCircle size={48} className="mx-auto text-gray-400 mb-3" />
          <p className="text-gray-500 dark:text-gray-400">
            No active claim sales right now.
          </p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
            Claim sales are multi-card bundles listed by sellers.
          </p>
          <Link href="/bazaar" className="btn btn-primary btn-md inline-flex mt-4">
            Browse the Bazaar
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Claim Sales</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Multi-card bundles from sellers. Claim the whole sale before it expires.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {claimSales.map((cs) => {
          const delivery = DELIVERY_LABELS[cs.delivery_option] || DELIVERY_LABELS.both
          const DeliveryIcon = delivery.icon
          return (
            <Link
              key={cs.id}
              href={`/claim-sales/${cs.id}`}
              className="group rounded-dbb bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-dbb-tertiary/40 p-4 card-hover block"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-dbb-accent transition-colors line-clamp-2">
                  {cs.title}
                </h3>
                <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 shrink-0">
                  <Star size={12} />
                  {cs.follower_count || 0}
                </div>
              </div>

              {cs.description && (
                <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mb-2">
                  {cs.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                {cs.seller_name && (
                  <span>by {cs.seller_name}</span>
                )}
                {cs.set_code && (
                  <span className="uppercase">{cs.set_code}</span>
                )}
                <span className="flex items-center gap-1">
                  <Clock size={10} />
                  {formatExpiry(cs.expires_at)}
                </span>
                <span className="flex items-center gap-1">
                  <DeliveryIcon size={10} />
                  {delivery.label}
                </span>
                <span>{cs.card_count || 0} cards</span>
              </div>
            </Link>
          )
        })}
      </div>

      {hasMore && (
        <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-6">
          Showing {claimSales.length} of {total} claim sales
        </p>
      )}
    </div>
  )
}