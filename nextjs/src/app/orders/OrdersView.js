'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, Loader2, MapPin, PackageCheck } from 'lucide-react'
import Link from 'next/link'

const STATUS_LABELS = {
  awaiting_payment: 'Awaiting bank-in',
  preparing_order: 'Preparing order',
  payment_received: 'Payment received',
  dropped_off: 'Dropped off',
  order_completed: 'Completed',
  cancelled: 'Cancelled',
}

const SELLER_NEXT = {
  awaiting_payment: { action: 'preparing_order', label: 'Mark preparing order' },
  preparing_order: { action: 'payment_received', label: 'Mark payment received' },
  payment_received: { action: 'dropped_off', label: 'Mark dropped off' },
}

export default function OrdersView() {
  const [orders, setOrders] = useState([])
  const [thresholds, setThresholds] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/orders', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load orders')
      setOrders(data.orders || [])
      setThresholds(data.thresholds || null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const post = async (order, path, body) => {
    setBusyId(order.id)
    setError(null)
    try {
      const res = await fetch(`/api/orders/${order.id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Order update failed')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const transition = (order, action) => {
    let reason = null
    if (action === 'cancel') {
      reason = window.prompt('Why are you cancelling this order? (5–500 characters)')
      if (reason == null) return
    }
    post(order, 'transition', { action, reason })
  }

  const requestCancellation = (order) => {
    const reason = window.prompt('Why are you requesting cancellation? (5–500 characters)')
    if (reason == null) return
    post(order, 'cancellation-request', { reason })
  }

  const reportNoShow = (order) => {
    const reason = window.prompt('Describe the no-show or stale order (5–500 characters)')
    if (reason == null) return
    post(order, 'no-show', { reason })
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-7 h-7 animate-spin text-dbb-accent" /></div>
  if (!orders.length) {
    return (
      <div className="text-center py-16 border border-dashed border-gray-300 dark:border-gray-700 rounded-xl">
        <PackageCheck className="w-12 h-12 mx-auto text-gray-400 mb-3" />
        <p className="font-medium">No orders yet</p>
        <Link href="/bazaar" className="btn btn-outline btn-sm mt-4">Browse the Bazaar</Link>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {error && <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-dbb-sm text-red-600 dark:text-red-400">{error}</div>}
      {orders.map(order => {
        const sellerNext = order.role === 'seller' ? SELLER_NEXT[order.status] : null
        const buyerCanComplete = order.role === 'buyer' && order.status === 'dropped_off'
        const final = ['order_completed', 'cancelled'].includes(order.status)
        const openCancelRequest = (order.order_cancellation_requests || []).find(request => !request.resolved_at)
        return (
          <article key={order.id} className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex flex-wrap justify-between gap-3">
              <div>
                <p className="text-dbb-xs text-gray-500">{order.role === 'buyer' ? `Buying from ${order.seller_name}` : `Selling to ${order.buyer_name}`}</p>
                <h2 className="font-semibold mt-1">{STATUS_LABELS[order.status] || order.status}</h2>
                <p className="text-[11px] text-gray-500 mt-1">Order {order.id}</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold text-dbb-accent">RM {Number(order.total_myr).toFixed(2)}</p>
                <p className="text-dbb-xs text-gray-500">{new Date(order.created_at).toLocaleString('en-MY')}</p>
              </div>
            </div>

            <div className="p-5">
              <div className="space-y-2">
                {(order.order_items || []).map(item => (
                  <div key={item.id} className="flex justify-between gap-4 text-dbb-sm">
                    <span>{item.card_name} <span className="text-gray-500">{item.set_code ? `(${item.set_code})` : ''} {item.collector_number ? `#${item.collector_number}` : ''}</span></span>
                    <span className="font-medium">RM {Number(item.line_myr).toFixed(2)}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 p-3 rounded-lg bg-gray-50 dark:bg-dbb-primary/60 flex gap-2">
                <MapPin className="w-4 h-4 text-dbb-accent flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-dbb-sm font-medium">{order.pickup_locations?.name}</p>
                  <p className="text-dbb-xs text-gray-500 mt-1">{order.pickup_locations?.address}</p>
                </div>
              </div>

              <OrderTimeline order={order} />

              {openCancelRequest && (
                <div className="mt-4 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-dbb-sm">
                  <p className="font-medium text-amber-700 dark:text-amber-300">Buyer requested cancellation</p>
                  <p className="text-dbb-xs mt-1">{openCancelRequest.reason}</p>
                  <p className="text-[11px] text-gray-500 mt-1">Requested {new Date(openCancelRequest.requested_at).toLocaleString('en-MY')}</p>
                </div>
              )}
              {order.status === 'cancelled' && (
                <div className="mt-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-dbb-sm">
                  <p className="font-medium">Cancelled by seller</p>
                  <p className="text-dbb-xs mt-1">{order.cancellation_reason}</p>
                  <p className="text-[11px] text-gray-500 mt-1">{order.cancelled_at && new Date(order.cancelled_at).toLocaleString('en-MY')}</p>
                </div>
              )}

              <div className="flex flex-wrap gap-2 mt-5">
                {sellerNext && <button disabled={busyId === order.id} onClick={() => transition(order, sellerNext.action)} className="btn btn-primary btn-sm">{sellerNext.label}</button>}
                {buyerCanComplete && <button disabled={busyId === order.id} onClick={() => transition(order, 'order_completed')} className="btn btn-primary btn-sm">Mark order completed</button>}
                {order.role === 'seller' && !final && <button disabled={busyId === order.id} onClick={() => transition(order, 'cancel')} className="btn btn-danger btn-sm">Cancel order</button>}
                {order.role === 'buyer' && !final && !openCancelRequest && <button disabled={busyId === order.id} onClick={() => requestCancellation(order)} className="btn btn-outline btn-sm">Request cancellation</button>}
                {order.no_show?.eligible && !order.no_show.already_reported && (
                  <button disabled={busyId === order.id} onClick={() => reportNoShow(order)} className="btn btn-outline btn-sm inline-flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> Report no-show
                  </button>
                )}
                {busyId === order.id && <Loader2 className="w-4 h-4 animate-spin text-dbb-accent self-center" />}
              </div>
              {order.no_show && !order.no_show.eligible && (
                <p className="text-[11px] text-gray-500 mt-2">
                  No-show reporting becomes available {new Date(order.no_show.eligible_at).toLocaleString('en-MY')}
                  {thresholds && ` under the configured ${order.no_show.type === 'buyer_unpaid' ? thresholds.unpaid_buyer_hours : thresholds.seller_stale_after_payment_hours}-hour threshold`}.
                </p>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}

function OrderTimeline({ order }) {
  const steps = [
    ['created_at', 'Checkout created'],
    ['preparing_order_at', 'Seller preparing'],
    ['payment_received_at', 'Payment received'],
    ['dropped_off_at', 'Dropped at store'],
    ['completed_at', 'Buyer completed'],
  ]
  return (
    <div className="grid sm:grid-cols-5 gap-2 mt-4">
      {steps.map(([field, label]) => {
        const timestamp = order[field]
        return (
          <div key={field} className={`rounded-lg border p-2 ${timestamp ? 'border-green-500/30 bg-green-500/5' : 'border-gray-200 dark:border-gray-700'}`}>
            <div className="flex items-center gap-1 text-dbb-xs font-medium">
              {timestamp ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <Clock3 className="w-3.5 h-3.5 text-gray-400" />}
              {label}
            </div>
            {timestamp && <p className="text-[10px] text-gray-500 mt-1">{new Date(timestamp).toLocaleString('en-MY')}</p>}
          </div>
        )
      })}
    </div>
  )
}
