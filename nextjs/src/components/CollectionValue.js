'use client'

import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'

export default function CollectionValue() {
  const [value, setValue] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/profile/value')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setValue(data) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <span className="hidden sm:inline-flex items-center gap-1 text-xs text-gray-600">
        <Loader2 className="w-3 h-3 animate-spin" />
      </span>
    )
  }

  if (!value || value.total_usd == null) return null

  return (
    <span className="hidden sm:inline-flex items-center gap-1 text-xs text-gray-500 border border-gray-700 rounded px-2 py-0.5">
      <span className="text-dbb-accent font-medium">${value.total_usd.toFixed(2)}</span>
      <span className="text-gray-600">/</span>
      <span>RM {value.total_myr?.toFixed(2) ?? (value.total_usd * 3).toFixed(2)}</span>
      <span className="text-gray-600 text-[10px]">@3.0</span>
    </span>
  )
}
