'use client'

import { useState, useEffect } from 'react'
import { X, BookOpen, Loader2 } from 'lucide-react'

export default function BinderPicker({ onSelect, onClose }) {
  const [binders, setBinders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch('/api/binders')
      .then(r => r.json())
      .then(data => {
        setBinders(data.binders || [])
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load binders')
        setLoading(false)
      })
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
      <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Move to binder</h2>
          <button onClick={onClose} className="text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3 max-h-80 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8 gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Loading binders...</span>
            </div>
          )}
          {error && <p className="text-sm text-red-400 p-3">{error}</p>}
          {!loading && !error && binders.length === 0 && (
            <p className="text-sm text-gray-500 p-3 text-center">No binders found.</p>
          )}
          {!loading && binders.map(b => (
            <button
              key={b.id}
              onClick={() => onSelect(b)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-100 dark:hover:bg-dbb-primary/60 transition-colors text-left"
            >
              <BookOpen className="w-4 h-4 text-dbb-accent flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{b.name}</div>
                <div className="text-xs text-gray-500">{b.card_count || 0} cards</div>
              </div>
              {b.is_default && (
                <span className="text-xs text-dbb-accent border border-dbb-accent/40 rounded px-1.5 py-0.5 flex-shrink-0">Default</span>
              )}
            </button>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="w-full text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 rounded-lg py-2 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
