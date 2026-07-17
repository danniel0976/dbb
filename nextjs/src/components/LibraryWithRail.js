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
    <div className="flex flex-col gap-5 md:flex-row md:gap-8">
      {/* Binder rail — horizontal scroll on mobile, vertical sidebar on desktop */}
      <div className="md:w-52 md:flex-shrink-0">
        <div className="overflow-x-auto md:overflow-x-visible md:rounded-[16px] md:bg-black/[.03] md:p-2 dark:md:bg-white/[.04]">
          <p className="mb-2 hidden px-2 py-1 text-xs font-medium uppercase tracking-wider text-gray-500 md:block dark:text-gray-400">Binders</p>
          <div className="flex min-w-max flex-row gap-2 md:min-w-0 md:flex-col md:gap-1">
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
