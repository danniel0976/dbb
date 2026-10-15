'use client'

import { ChevronDown, Loader2 } from 'lucide-react'
import { PRINTING_SELECTION_NOTE, printingSelectionCopy } from '@/lib/cardScannerView.mjs'

/**
 * The scanner's printing chooser: the labelled shell around candidate rows the
 * caller supplies as children.
 *
 * This is a panel inside the scanner, so it carries no dialog semantics and
 * claims none — the camera and the shelf stay on screen around it, and the user
 * is choosing which printing a scan meant, not dismissing a popup.
 */
export function PrintingSelectionPanel({
  reason,
  count = 0,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  children,
}) {
  const copy = printingSelectionCopy(reason)
  return (
    <div
      role="group"
      aria-label="Printing selection"
      className="space-y-2 rounded-dbb-md border border-amber-400/40 bg-amber-500/5 p-2"
    >
      <p className="text-dbb-xs font-semibold text-amber-700 dark:text-amber-300">{copy.heading}</p>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">{copy.detail}</p>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        {count} {copy.countNoun}{count === 1 ? '' : 's'} to choose from. {PRINTING_SELECTION_NOTE}
      </p>

      <div className="max-h-64 space-y-1 overflow-y-auto">{children}</div>

      {/* The candidate pool is reachable past the first catalog page; loading
          more only widens this list. */}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-dbb-md border border-gray-200 text-dbb-xs text-gray-600 transition-colors hover:border-dbb-accent hover:text-dbb-accent disabled:opacity-50 dark:border-gray-700 dark:text-gray-400"
        >
          {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
          Load more printings
        </button>
      )}
    </div>
  )
}

/**
 * Card-name line for a candidate row. Shown when the options span more than one
 * card, so rows are told apart by text and not only by artwork.
 */
export function CandidateCardName({ cardName }) {
  if (!cardName) return null
  return <p className="text-xs font-medium text-gray-900 dark:text-white truncate">{cardName}</p>
}

export default PrintingSelectionPanel
