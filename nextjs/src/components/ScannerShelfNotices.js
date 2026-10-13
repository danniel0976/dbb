'use client'

import { ScanLine } from 'lucide-react'
import { heldScansLabel } from '@/lib/cardScannerView.mjs'

/**
 * Shown when closing the modal would destroy a non-empty scan shelf.
 *
 * The shelf is the only record of a scanning session, so the close stops here
 * once and names what is at stake in both counts. Discarding needs a second,
 * explicit click; the other way out stays in the modal with the shelf intact.
 * The prompt can appear from scanner or manual-search mode, so its safe action
 * does not claim the camera will reopen.
 */
export function ScannerExitPrompt({ rows = 0, quantity = 0, onKeep, onDiscard }) {
  if (rows < 1) return null
  return (
    <div
      role="alert"
      className="mb-3 space-y-2 rounded-dbb-md border border-amber-400/50 bg-amber-500/10 p-3"
    >
      <p className="text-dbb-sm font-semibold text-amber-700 dark:text-amber-300">
        {rows} scanned printing{rows === 1 ? '' : 's'} ({quantity} card{quantity === 1 ? '' : 's'}){' '}
        {rows === 1 ? 'has' : 'have'} not been added yet.
      </p>
      <p className="text-dbb-xs text-gray-600 dark:text-gray-400">
        Closing now discards them. Nothing has been written to your library.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onKeep}
          className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-dbb-md bg-dbb-accent text-dbb-sm font-semibold text-white transition-colors hover:bg-dbb-accent-hov"
        >
          <ScanLine className="h-4 w-4" />
          Keep scans and stay
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border border-gray-200 text-dbb-sm text-gray-600 transition-colors hover:border-red-500 hover:text-red-500 dark:border-gray-700 dark:text-gray-400"
        >
          Discard scans and close
        </button>
      </div>
    </div>
  )
}

/**
 * Shown in manual search once scanner mode has been left with scans on the shelf.
 * Leaving the scanner hides the shelf, so without this the pending scans would
 * be invisible and look lost even though they are held.
 */
export function HeldScansBanner({ rows = 0, quantity = 0, onResume }) {
  const label = heldScansLabel({ rows, quantity })
  if (!label) return null
  return (
    <div className="flex items-center justify-between gap-2 rounded-dbb-md border border-dbb-accent/40 bg-dbb-accent/5 p-2">
      <p className="text-dbb-xs text-gray-600 dark:text-gray-300">{label}</p>
      <button
        type="button"
        onClick={onResume}
        className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-dbb-md px-2 text-dbb-xs font-semibold text-dbb-accent transition-colors hover:bg-dbb-accent/10"
      >
        <ScanLine className="h-3.5 w-3.5" />
        Resume scanning
      </button>
    </div>
  )
}
