'use client'

import { useState, useEffect, useCallback } from 'react'
import { Trash2, Loader2, ShoppingCart, AlertTriangle, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useToast } from '@/components/Toast'

const FOIL_BADGES = {
  foil: { label: 'Foil', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  etched: { label: 'Etched', cls: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
}

function groupBySeller(items) {
  const groups = {}
  for (const item of items) {
    const key = item.seller_id || '__unknown__'
    if (!groups[key]) {
      groups[key] = {
        seller_id: item.seller_id,
        seller_name: item.seller_name || 'Unknown Seller',
        items: [],
        subtotal: 0,
      }
    }
    groups[key].items.push(item)
    if (item.is_available && item.myr_price != null) {
      groups[key].subtotal = Math.round((groups[key].subtotal + item.myr_price) * 100) / 100
    }
  }
  return Object.values(groups)
}

export default function CartView() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [removingId, setRemovingId] = useState(null)
  const { toast } = useToast()

  const fetchCart = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/cart')
      if (!res.ok) throw new Error('Failed to load cart')
      const data = await res.json()
      setItems(data.items || [])
    } catch {
      toast('Failed to load cart', 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchCart()
  }, [fetchCart])

  const handleRemove = async (cartItemId) => {
    setRemovingId(cartItemId)
    try {
      const res = await fetch(`/api/cart/${cartItemId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to remove')
      setItems(prev => prev.filter(i => i.id !== cartItemId))
      toast('Removed from cart', 'success')
    } catch {
      toast('Failed to remove item', 'error')
    } finally {
      setRemovingId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-dbb-accent" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-20">
        <ShoppingCart className="w-16 h-16 mx-auto mb-4 text-gray-600" />
        <h2 className="text-xl font-semibold mb-2">Your cart is empty</h2>
        <p className="text-gray-400 mb-6">Browse the Bazaar to find cards you'd like to buy.</p>
        <Link href="/bazaar" className="btn btn-primary btn-md inline-block">
          Browse the Bazaar →
        </Link>
      </div>
    )
  }

  const availableItems = items.filter(i => i.is_available && i.myr_price != null)
  const grandTotal = Math.round(
    availableItems.reduce((sum, i) => sum + i.myr_price, 0) * 100
  ) / 100

  const groups = groupBySeller(items)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {groups.map(group => (
        <div key={group.seller_id || '__unknown__'} className="bg-dbb-secondary rounded-xl border border-gray-700 overflow-hidden">
          {/* Seller header */}
          <div className="px-4 py-3 border-b border-gray-700 bg-dbb-primary/60 flex items-center justify-between">
            <span className="text-sm font-semibold text-white">{group.seller_name}</span>
            <span className="text-xs text-gray-500">
              {group.items.length} item{group.items.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Items */}
          <div className="divide-y divide-gray-700/50">
            {group.items.map(item => {
              const ci = item.library_card?.card_index
              const foilBadge = item.library_card?.foil && FOIL_BADGES[item.library_card.foil]
              const isRemoving = removingId === item.id
              return (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 px-4 py-3 ${!item.is_available ? 'opacity-60' : ''}`}
                >
                  {/* Card info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white truncate">
                        {ci?.name || 'Unknown card'}
                      </span>
                      {!item.is_available && (
                        <span className="flex items-center gap-1 text-[10px] bg-red-900/40 text-red-400 border border-red-700/40 rounded px-1.5 py-0.5">
                          <AlertTriangle className="w-3 h-3" /> Unavailable
                        </span>
                      )}
                      {foilBadge && (
                        <span className={`text-[10px] border rounded px-1 py-0.5 ${foilBadge.cls}`}>
                          {foilBadge.label}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 space-x-2">
                      {ci?.set_name && <span>{ci.set_name}</span>}
                      {ci?.collector_number && <span>#{ci.collector_number}</span>}
                      {item.library_card?.condition && (
                        <span className="border border-gray-600 rounded px-1 py-0.5 text-gray-400">
                          {item.library_card.condition}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Price */}
                  <div className="text-right flex-shrink-0">
                    {item.is_available && item.myr_price != null ? (
                      <>
                        <div className="text-sm font-semibold text-dbb-accent">
                          RM {item.myr_price.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-gray-600">×{item.multiplier}</div>
                      </>
                    ) : (
                      <div className="text-xs text-gray-600">—</div>
                    )}
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => handleRemove(item.id)}
                    disabled={isRemoving}
                    className="p-1.5 text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                    title="Remove from cart"
                  >
                    {isRemoving
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <Trash2 className="w-4 h-4" />
                    }
                  </button>
                </div>
              )
            })}
          </div>

          {/* Seller subtotal */}
          <div className="px-4 py-2.5 border-t border-gray-700 bg-dbb-primary/40 flex justify-between items-center">
            <span className="text-xs text-gray-500">Subtotal ({group.seller_name})</span>
            <span className="text-sm font-medium text-white">
              RM {group.subtotal.toFixed(2)}
            </span>
          </div>
        </div>
      ))}

      {/* Grand total */}
      <div className="bg-dbb-primary border border-dbb-accent/30 rounded-xl px-5 py-4 flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-400">Grand Total</p>
          {items.some(i => !i.is_available) && (
            <p className="text-xs text-gray-600 mt-0.5">Unavailable items not included</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-dbb-accent">RM {grandTotal.toFixed(2)}</p>
          <p className="text-xs text-gray-500">{availableItems.length} item{availableItems.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm">
        <Link href="/bazaar" className="btn btn-outline btn-sm inline-flex items-center gap-1">
          <ExternalLink className="w-3.5 h-3.5" /> Continue shopping
        </Link>
        <p className="text-gray-500 text-xs">Checkout coming soon</p>
      </div>
    </div>
  )
}
