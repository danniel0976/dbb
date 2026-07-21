'use client'

import { useState } from 'react'
import { useToast } from '@/components/Toast'
import { Minus, Plus, Package } from 'lucide-react'
import { DURATION_OPTIONS } from './constants'

export default function ClaimSaleForm({ libraryRow, onCancel, onRequirePhoto }) {
  const { toast } = useToast()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [setCode, setSetCode] = useState(libraryRow?.card_index?.set_code || '')
  const [durationHours, setDurationHours] = useState(24)
  const [deliveryOption, setDeliveryOption] = useState('pickup')
  const [csQuantity, setCsQuantity] = useState(1)
  const [submitting, setSubmitting] = useState(false)

  const ownedQty = libraryRow?.quantity || 1

  const handleCreate = async () => {
    if (!title.trim()) {
      toast('Title is required', 'error')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/claim-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          set_code: setCode.trim() || undefined,
          duration_hours: durationHours,
          delivery_option: deliveryOption,
          card_ids: [libraryRow.id],
          quantities: { [libraryRow.id]: csQuantity },
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 422 && err.missing_photos?.includes(libraryRow.id)) {
          onRequirePhoto?.(handleCreate)
          return
        }
        throw new Error(err.error || 'Failed')
      }
      toast('Claim sale created on Bazaar', 'success')
      onCancel()
    } catch (e) {
      toast(e.message || 'Failed to create claim sale', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="pt-2 border-t border-black/5 dark:border-white/10 space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400 font-medium flex items-center gap-1">
        <Package className="w-3 h-3" /> Claim Sale
      </p>

      <div>
        <input
          type="text"
          placeholder="Claim sale title (e.g. Modern staples sale)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
        />
      </div>

      <div>
        <textarea
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600 resize-none"
        />
      </div>

      <div>
        <input
          type="text"
          placeholder="Set code (optional, e.g. MKM)"
          value={setCode}
          onChange={(e) => setSetCode(e.target.value)}
          className="w-full bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
        />
      </div>

      <div>
        <p className="text-xs text-gray-600 mb-1.5">Duration (max 24h)</p>
        <div className="flex gap-1.5">
          {DURATION_OPTIONS.map(({ hours, label }) => (
            <button
              key={hours}
              onClick={() => setDurationHours(hours)}
              className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                durationHours === hours
                  ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-600 mb-1.5">Delivery option</p>
        <div className="flex gap-2">
            {[
              { value: 'pickup', label: 'TCG store pickup' },
            ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setDeliveryOption(opt.value)}
              className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                deliveryOption === opt.value
                  ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Quantity picker for claim sale */}
      {ownedQty > 1 && (
        <div>
          <p className="text-xs text-gray-600 mb-1.5">Quantity (max {ownedQty})</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCsQuantity(q => Math.max(1, q - 1))}
              className="p-1 rounded bg-gray-100 dark:bg-dbb-secondary hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Minus className="w-4 h-4" />
            </button>
            <input
              type="number"
              min="1"
              max={ownedQty}
              value={csQuantity}
              onChange={(e) => {
                const v = parseInt(e.target.value) || 1
                setCsQuantity(Math.max(1, Math.min(ownedQty, v)))
              }}
              className="w-16 text-center bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:border-dbb-accent focus:outline-none"
            />
            <button
              onClick={() => setCsQuantity(q => Math.min(ownedQty, q + 1))}
              className="p-1 rounded bg-gray-100 dark:bg-dbb-secondary hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
            <span className="text-xs text-gray-500 ml-1">of {ownedQty} owned</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleCreate}
          disabled={submitting}
          className="flex-1 py-1.5 text-sm bg-dbb-accent hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {submitting ? 'Creating...' : 'Create Claim Sale'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
