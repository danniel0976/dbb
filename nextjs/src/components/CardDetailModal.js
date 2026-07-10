'use client'

import { useState, useEffect, useCallback } from 'react'
import { getCardById, getImageUrl } from '@/lib/scryfall'
import { useToast } from '@/components/Toast'
import { X, Star, Minus, Plus, Trash2 } from 'lucide-react'

const CONDITIONS = ['M', 'NM', 'LP', 'MP', 'HP', 'DMG']
const FOILS = ['normal', 'foil', 'etched']

export default function CardDetailModal({ libraryRow, onClose, onSave, onDelete }) {
  const { toast } = useToast()
  const [cardData, setCardData] = useState(null)
  const [imageUrl, setImageUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [quantity, setQuantity] = useState(libraryRow.quantity)
  const [condition, setCondition] = useState(libraryRow.condition)
  const [foil, setFoil] = useState(libraryRow.foil)
  const [language, setLanguage] = useState(libraryRow.language)
  const [starred, setStarred] = useState(libraryRow.starred)

  const ci = libraryRow.card_index

  useEffect(() => {
    getCardById(libraryRow.scryfall_id)
      .then(data => {
        setCardData(data)
        setImageUrl(getImageUrl(data))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [libraryRow.scryfall_id])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(`/api/library/${libraryRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity, condition, foil, language, starred }),
      })
      if (!res.ok) throw new Error('Save failed')
      const { card } = await res.json()
      toast('Card updated', 'success')
      onSave({ ...libraryRow, ...card, card_index: ci })
      onClose()
    } catch {
      toast('Failed to save changes', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/library/${libraryRow.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      toast('Card removed from library', 'success')
      onDelete(libraryRow.id)
      onClose()
    } catch {
      toast('Failed to delete card', 'error')
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-dbb-primary border border-dbb-accent/30 rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-bold text-white truncate pr-4">
            {ci?.name || cardData?.name || 'Card Details'}
          </h2>
          <button onClick={onClose} className="p-1 hover:text-dbb-accent transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 p-4">
          {/* Image */}
          <div className="sm:w-48 flex-shrink-0">
            {loading ? (
              <div className="aspect-[2/3] skeleton rounded-lg" />
            ) : imageUrl ? (
              <img
                src={imageUrl}
                alt={ci?.name || 'Card'}
                className="w-full rounded-lg shadow-lg"
              />
            ) : (
              <div className="aspect-[2/3] bg-dbb-secondary rounded-lg flex items-center justify-center">
                <span className="text-gray-500 text-sm text-center p-2">{ci?.name}</span>
              </div>
            )}
          </div>

          {/* Details + edit */}
          <div className="flex-1 flex flex-col gap-4">
            {/* Card metadata */}
            <div className="text-sm text-gray-400 space-y-1">
              {(ci?.set_name || cardData?.set_name) && (
                <div><span className="text-gray-500">Set:</span> {ci?.set_name || cardData?.set_name}</div>
              )}
              {(ci?.rarity || cardData?.rarity) && (
                <div><span className="text-gray-500">Rarity:</span> {ci?.rarity || cardData?.rarity}</div>
              )}
              {(ci?.type_line || cardData?.type_line) && (
                <div><span className="text-gray-500">Type:</span> {ci?.type_line || cardData?.type_line}</div>
              )}
              {cardData?.oracle_text && (
                <div className="mt-2 p-2 bg-dbb-secondary rounded text-xs leading-relaxed whitespace-pre-line">
                  {cardData.oracle_text}
                </div>
              )}
            </div>

            {/* Editable fields */}
            <div className="space-y-3">
              {/* Quantity */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Quantity</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setQuantity(q => Math.max(1, q - 1))}
                    className="p-1 rounded bg-dbb-secondary hover:bg-gray-700 transition-colors"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <input
                    type="number"
                    min="1"
                    max="9999"
                    value={quantity}
                    onChange={(e) => setQuantity(Math.max(1, Math.min(9999, parseInt(e.target.value) || 1)))}
                    className="w-16 text-center bg-dbb-secondary border border-gray-700 rounded px-2 py-1 text-sm focus:border-dbb-accent focus:outline-none"
                  />
                  <button
                    onClick={() => setQuantity(q => Math.min(9999, q + 1))}
                    className="p-1 rounded bg-dbb-secondary hover:bg-gray-700 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Condition */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Condition</label>
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  className="bg-dbb-secondary border border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
                >
                  {CONDITIONS.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              {/* Foil */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Finish</label>
                <select
                  value={foil}
                  onChange={(e) => setFoil(e.target.value)}
                  className="bg-dbb-secondary border border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
                >
                  {FOILS.map(f => (
                    <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
                  ))}
                </select>
              </div>

              {/* Language */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Language</label>
                <input
                  type="text"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value.toLowerCase().slice(0, 5))}
                  placeholder="en"
                  className="w-24 bg-dbb-secondary border border-gray-700 rounded px-3 py-1.5 text-sm focus:border-dbb-accent focus:outline-none"
                />
              </div>

              {/* Star */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-400 w-24">Starred</label>
                <button
                  onClick={() => setStarred(s => !s)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded border transition-colors ${
                    starred
                      ? 'border-yellow-500 bg-yellow-500/10 text-yellow-400'
                      : 'border-gray-700 text-gray-500 hover:border-yellow-500/50'
                  }`}
                >
                  <Star className="w-4 h-4" fill={starred ? 'currentColor' : 'none'} />
                  {starred ? 'Starred' : 'Star this card'}
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-gray-700">
              {!confirmDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-2 text-sm text-red-400 hover:text-red-300 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Remove
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-red-400">Remove from library?</span>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="text-sm bg-red-700 hover:bg-red-600 px-3 py-1 rounded transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Removing...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-1.5 text-sm bg-dbb-accent hover:bg-red-600 text-white rounded transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
