'use client'

import { useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import BinderRail from './BinderRail'
import LibraryView from './LibraryView'

export default function LibraryWithRail({ userId, initialData, initialBinders = [], initialBinderId }) {
  const searchParams = useSearchParams()
  const [selectedBinderId, setSelectedBinderId] = useState(initialBinderId || null)
  const [binders, setBinders] = useState(initialBinders)

  const handleSelectBinder = useCallback((id) => {
    setSelectedBinderId(id)
    // Update URL without triggering a server re-render (no router.replace).
    // This prevents the double-fetch pattern where both server prefetch AND
    // client reload fire for the same binder switch.
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set('binder', id)
    else params.delete('binder')
    params.delete('q')
    params.delete('sort')
    const newUrl = `${window.location.pathname}?${params}`
    window.history.replaceState(null, '', newUrl)
  }, [searchParams])

  return (
    <div className="flex flex-col md:flex-row gap-4">
      {/* Binder rail — horizontal scroll on mobile, vertical sidebar on desktop */}
      <div className="md:w-52 md:flex-shrink-0">
        <div className="overflow-x-auto md:overflow-x-visible md:bg-dbb-secondary/50 md:border md:border-gray-800 md:rounded-xl md:p-2">
          <p className="hidden md:block text-xs font-medium text-gray-500 uppercase tracking-wider px-2 py-1.5 mb-1">Binders</p>
          <div className="flex flex-row md:flex-col gap-2 md:gap-0.5 min-w-max md:min-w-0">
            <BinderRail
              initialBinders={binders}
              selectedId={selectedBinderId}
              onSelect={handleSelectBinder}
              onBindersChange={setBinders}
            />
          </div>
        </div>
      </div>

      {/* Library content — key forces remount when binder changes */}
      <div className="flex-1 min-w-0">
        <LibraryView
          key={selectedBinderId || '__all__'}
          userId={userId}
          initialData={selectedBinderId === initialBinderId ? initialData : null}
          binders={binders}
          binderId={selectedBinderId}
        />
      </div>
    </div>
  )
}
