'use client'

import { useState, useEffect, useCallback } from 'react'
import { Trash2, Loader2, ShoppingCart, AlertTriangle, ExternalLink, Landmark, MapPin, CheckCircle2 } from 'lucide-react'
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
  const [locations, setLocations] = useState([])
  const [pickupLocationId, setPickupLocationId] = useState('')
  const [checkingOut, setCheckingOut] = useState(false)
  const [checkoutKey, setCheckoutKey] = useState(() => crypto.randomUUID())
  const [checkoutResult, setCheckoutResult] = useState(null)
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

  useEffect(() => {
    fetch('/api/checkout')
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Checkout is unavailable')
        const available = data.locations || []
        setLocations(available)
        const preferred = available.find(location => location.is_default) || available[0]
        setPickupLocationId(preferred?.id || '')
      })
      .catch(error => toast(error.message, 'error'))
  }, [toast])

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

  const handleCheckout = async () => {
    if (!pickupLocationId) return
    setCheckingOut(true)
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickup_location_id: pickupLocationId,
          idempotency_key: checkoutKey,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        const conflict = data.conflicts?.[0]?.reason
        throw new Error(conflict ? `${data.error}: ${conflict}` : (data.error || 'Checkout failed'))
      }
      setCheckoutResult(data)
      setItems([])
      toast('Orders created. Bank in to each seller using the details shown.', 'success')
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      setCheckingOut(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-dbb-accent" />
      </div>
    )
  }

  if (checkoutResult) {
    return <CheckoutPaymentResult result={checkoutResult} />
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-20">
        <ShoppingCart className="w-16 h-16 mx-auto mb-4 text-gray-600" />
        <h2 className="text-xl font-semibold mb-2">Your cart is empty</h2>
        <p className="text-gray-500 dark:text-gray-400 mb-6">Browse the Bazaar to find cards you'd like to buy.</p>
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
  const selectedLocation = locations.find(location => location.id === pickupLocationId)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {groups.map(group => (
        <div key={group.seller_id || '__unknown__'} className="bg-white dark:bg-dbb-secondary rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {/* Seller header */}
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-dbb-primary/60 flex items-center justify-between">
            <span className="text-dbb-sm font-semibold text-gray-900 dark:text-white">{group.seller_name}</span>
            <span className="text-dbb-xs text-gray-600 dark:text-gray-500">
              {group.items.length} item{group.items.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Items */}
          <div className="divide-y divide-gray-200 dark:divide-gray-700/50">
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
                      <span className="text-dbb-sm font-medium text-gray-900 dark:text-white truncate">
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
                    <div className="text-dbb-xs text-gray-600 dark:text-gray-500 mt-0.5 space-x-2">
                      {ci?.set_name && <span>{ci.set_name}</span>}
                      {ci?.collector_number && <span>#{ci.collector_number}</span>}
                      {item.library_card?.condition && (
                        <span className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 text-gray-500 dark:text-gray-400">
                          {item.library_card.condition}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Price */}
                  <div className="text-right flex-shrink-0">
                    {item.is_available && item.myr_price != null ? (
                      <>
                        <div className="text-dbb-sm font-semibold text-dbb-accent">
                          RM {item.myr_price.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-gray-600">×{item.multiplier}</div>
                      </>
                    ) : (
                      <div className="text-dbb-xs text-gray-600">—</div>
                    )}
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => handleRemove(item.id)}
                    disabled={isRemoving}
                    className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50"
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
          <div className="px-4 py-2.5 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-dbb-primary/40 flex justify-between items-center">
            <span className="text-dbb-xs text-gray-600 dark:text-gray-500">Subtotal ({group.seller_name})</span>
            <span className="text-dbb-sm font-medium text-gray-900 dark:text-white">
              RM {group.subtotal.toFixed(2)}
            </span>
          </div>
        </div>
      ))}

      <div className="bg-white dark:bg-dbb-secondary rounded-xl border border-gray-200 dark:border-gray-700 p-5">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="w-4 h-4 text-dbb-accent" />
          <h2 className="text-dbb-sm font-semibold text-gray-900 dark:text-white">TCG store pickup</h2>
        </div>
        <select
          value={pickupLocationId}
          onChange={event => setPickupLocationId(event.target.value)}
          className="w-full bg-gray-50 dark:bg-dbb-primary border border-gray-200 dark:border-gray-700 rounded-lg h-11 px-3 text-dbb-sm focus:outline-none focus:border-dbb-accent"
        >
          {locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select>
        {selectedLocation && (
          <div className="mt-3 rounded-lg bg-gray-50 dark:bg-dbb-primary/60 border border-gray-200 dark:border-gray-700 p-3">
            <p className="text-dbb-sm font-medium">{selectedLocation.name}</p>
            <p className="text-dbb-xs text-gray-500 mt-1">{selectedLocation.address}</p>
            {selectedLocation.operating_notes && <p className="text-dbb-xs text-amber-600 dark:text-amber-400 mt-2">{selectedLocation.operating_notes}</p>}
          </div>
        )}
      </div>

      {/* Grand total */}
      <div className="bg-white dark:bg-dbb-primary border border-dbb-accent/30 rounded-xl px-5 py-4 flex items-center justify-between">
        <div>
          <p className="text-dbb-sm text-gray-600 dark:text-gray-400">Grand Total</p>
          {items.some(i => !i.is_available) && (
            <p className="text-dbb-xs text-gray-500 dark:text-gray-600 mt-0.5">Unavailable items not included</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-dbb-accent">RM {grandTotal.toFixed(2)}</p>
          <p className="text-dbb-xs text-gray-600 dark:text-gray-500">{availableItems.length} item{availableItems.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      <div className="flex items-center justify-between text-dbb-sm">
        <Link href="/bazaar" className="btn btn-outline btn-sm inline-flex items-center gap-1">
          <ExternalLink className="w-3.5 h-3.5" /> Continue shopping
        </Link>
        <button
          onClick={handleCheckout}
          disabled={checkingOut || !pickupLocationId || availableItems.length !== items.length}
          className="btn btn-primary btn-md inline-flex items-center gap-2 disabled:opacity-50"
        >
          {checkingOut ? <Loader2 className="w-4 h-4 animate-spin" /> : <Landmark className="w-4 h-4" />}
          Checkout & view bank-in details
        </button>
      </div>
    </div>
  )
}

function CheckoutPaymentResult({ result }) {
  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-5 flex gap-3">
        <CheckCircle2 className="w-6 h-6 text-green-500 flex-shrink-0" />
        <div>
          <h2 className="font-semibold text-gray-900 dark:text-white">Orders created</h2>
          <p className="text-dbb-sm text-gray-600 dark:text-gray-300 mt-1">Bank in separately to each seller. These private payment details are shown only in this checkout result; save your transfer receipts.</p>
        </div>
      </div>

      {result.orders.map(order => (
        <div key={order.id} className="bg-white dark:bg-dbb-secondary rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="p-5 border-b border-gray-200 dark:border-gray-700">
            <div className="flex justify-between gap-4">
              <div>
                <p className="text-dbb-xs text-gray-500">Pay seller</p>
                <h3 className="font-semibold">{order.payment?.seller_name || 'Seller'}</h3>
              </div>
              <div className="text-right">
                <p className="text-dbb-xs text-gray-500">Order total</p>
                <p className="text-xl font-bold text-dbb-accent">RM {Number(order.total_myr).toFixed(2)}</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-x-5 gap-y-2 mt-4 text-dbb-sm">
              <PaymentLine label="Bank / provider" value={order.payment?.bank_name} />
              <PaymentLine label="Account name" value={order.payment?.account_name} />
              <PaymentLine label="Account number" value={order.payment?.account_number} />
              <PaymentLine label="DuitNow ID" value={order.payment?.duitnow_id} />
            </div>
            {order.payment?.payment_instructions && <p className="text-dbb-sm mt-3 p-3 bg-gray-50 dark:bg-dbb-primary rounded-lg">{order.payment.payment_instructions}</p>}
            <div className="flex flex-wrap gap-4 mt-4">
              {order.payment?.bank_qr_url && <QrImage label="Bank / DuitNow QR" src={order.payment.bank_qr_url} />}
              {order.payment?.tng_qr_url && <QrImage label="Touch 'n Go QR" src={order.payment.tng_qr_url} />}
            </div>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-dbb-primary/50">
            <p className="text-dbb-xs font-medium">Pickup: {order.pickup_locations?.name}</p>
            <p className="text-dbb-xs text-gray-500 mt-1">{order.pickup_locations?.address}</p>
            <p className="text-[11px] text-gray-500 mt-2">Order {order.id}</p>
          </div>
        </div>
      ))}

      <div className="flex justify-end">
        <Link href="/orders" className="btn btn-primary btn-md">Track orders →</Link>
      </div>
    </div>
  )
}

function PaymentLine({ label, value }) {
  if (!value) return null
  return <p><span className="text-gray-500">{label}:</span> <span className="font-medium select-all">{value}</span></p>
}

function QrImage({ label, src }) {
  return (
    <div>
      <p className="text-dbb-xs text-gray-500 mb-1">{label}</p>
      <img src={src} alt={label} className="w-40 h-40 object-contain bg-white border rounded-lg" />
    </div>
  )
}
