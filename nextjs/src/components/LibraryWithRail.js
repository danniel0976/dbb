'use client'

import { useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import BinderRail from './BinderRail'
import LibraryView from './LibraryView'

export default function LibraryWithRail({ userId, initialData, initialBinders = [], initialBinderId }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [selectedBinderId, setSelectedBinderId] = useState(initialBinderId || null)
  const [binders, setBinders] = useState(initialBinders)
  const switchCount = useRef(0)

  const handleSelectBinder = useCallback((id) => {
    switchCount.current++
    setSelectedBinderId(id)
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set('binder', id)
    else params.delete('binder')
    // Strip per-view state that doesn't carry across binder context changes
    params.delete('q')
    router.replace(`/library?${params}`, { scroll: false })
  }, [router, searchParams])

  // Only use the server-prefetched initialData on the very first render with the right binder
  const isFirstLoad = switchCount.current === 0
  const libraryInitialData = (isFirstLoad && selectedBinderId === initialBinderId) ? initialData : null

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

      {/* Library content */}
      <div className="flex-1 min-w-0">
        <LibraryView
          key={selectedBinderId || '__all__'}
          userId={userId}
          initialData={libraryInitialData}
          binders={binders}
          binderId={selectedBinderId}
        />
      </div>
    </div>
  )
}
