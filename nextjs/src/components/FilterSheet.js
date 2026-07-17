'use client'

// Shared mobile bottom filter sheet (Phase 41 in-scope feature #1). Renders
// a title/close row, a scrollable body (the surface's existing filter
// controls, bound to *staged* draft state by the caller), and a sticky
// footer with "Clear all" + Apply. Desktop keeps its existing sidebar/panel
// — this component is only mounted/shown at mobile widths by its callers.

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

export default function FilterSheet({
  open,
  title = 'Filters',
  resultCount,
  onClose,
  onApply,
  onClearAll,
  applyLabel,
  triggerRef,
  children,
}) {
  const closeBtnRef = useRef(null)
  const sheetRef = useRef(null)

  useEffect(() => {
    if (!open) return
    closeBtnRef.current?.focus()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = sheetRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = ''
      // Restore focus to whatever opened the sheet (the Filters button).
      triggerRef?.current?.focus()
    }
  }, [open, onClose, triggerRef])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={sheetRef}
        className="absolute left-0 right-0 bottom-0 max-h-[85vh] w-full flex flex-col bg-white dark:bg-dbb-primary rounded-t-2xl shadow-xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-dbb-tertiary/30 shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close filters"
            className="min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-gray-100 dark:hover:bg-dbb-secondary rounded-dbb transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-1">
          {children}
        </div>

        <div
          className="shrink-0 border-t border-gray-200 dark:border-dbb-tertiary/30 p-3 flex items-center gap-2 bg-white dark:bg-dbb-primary"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={onClearAll}
            className="min-h-[44px] px-4 text-sm text-dbb-accent hover:text-dbb-accent-hov transition-colors"
          >
            Clear all
          </button>
          <button onClick={onApply} className="flex-1 min-h-[44px] btn btn-primary btn-md">
            {applyLabel || (resultCount != null ? `Show ${resultCount} results` : 'Apply filters')}
          </button>
        </div>
      </div>
    </div>
  )
}
