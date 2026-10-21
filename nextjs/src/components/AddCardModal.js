'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { attachScannerViewport, revealScannerNotice } from '@/lib/scannerViewport.mjs'
import { X, Search, Loader2, Plus, ChevronRight, ChevronDown, Filter, ScanLine } from 'lucide-react'
import { catalogImage } from '@/lib/scannerPrintings.mjs'
import { rankScannerResults, isUsablePrintingEvidence } from '@/lib/cardScanner.mjs'
import { compareScannerCandidatesVisually } from '@/lib/cardScannerVisualBrowser.mjs'
import {
  addScannerShelfItem,
  buildScannerBatchPayload,
  classifyBatchResponse,
  createScannerBatchLifecycle,
  createScannerCaptureLifecycle,
  removeSubmittedScannerRows,
  editScannerShelfItem,
  parseBatchResponseBody,
  removeScannerShelfItem,
  resolveScannerBatchExit,
  resolveScannerExit,
  shouldSweepAnotherScanPage,
  routeCatalogSelection,
  routeScannerMatch,
  scannerRetrievalSeed,
} from '@/lib/cardScannerSession.mjs'
import { scannerSelectionReason } from '@/lib/cardScannerView.mjs'
import CardScannerPanel, { terminateScannerWorker } from './CardScannerPanel'
import { PrintingSelectionPanel, CandidateCardName } from './ScannerPrintingSelection'
import { HeldScansBanner, ScannerExitPrompt } from './ScannerShelfNotices'

// Focus trap + scroll lock (matches CardDetailModal Pass 4a pattern)
function useFocusTrap(sheetRef, closeBtnRef, onClose, extraDeps = []) {
  useEffect(() => {
    closeBtnRef.current?.focus()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = sheetRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, ...extraDeps])
}

const CONDITIONS = [
  { value: 'NM', label: 'NM – Near Mint' },
  { value: 'LP', label: 'LP – Lightly Played' },
  { value: 'MP', label: 'MP – Moderately Played' },
  { value: 'HP', label: 'HP – Heavily Played' },
  { value: 'DMG', label: 'DMG – Damaged' },
  { value: 'M', label: 'M – Mint' },
]

const RARITY_OPTIONS = [
  { value: '', label: 'Any rarity' },
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'mythic', label: 'Mythic' },
]

const COLOR_OPTIONS = [
  { value: 'W', label: 'W', title: 'White' },
  { value: 'U', label: 'U', title: 'Blue' },
  { value: 'B', label: 'B', title: 'Black' },
  { value: 'R', label: 'R', title: 'Red' },
  { value: 'G', label: 'G', title: 'Green' },
  { value: 'C', label: 'C', title: 'Colorless' },
]

const RARITY_COLORS = {
  mythic: 'text-rarity-mythic',
  rare: 'text-rarity-rare',
  uncommon: 'text-rarity-uncommon',
  common: 'text-gray-400',
}

const DEFAULT_LIMIT = 20
// A scan pulls a wider candidate pool so client-side ranking has something to
// order (LLD §5.3); the catalog route caps limit at 40.
const SCAN_LIMIT = 40

function CardImage({ card, size = 'sm' }) {
  const [src, setSrc] = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (catalogImage(card)?.small) {
      setSrc(catalogImage(card).small)
      return
    }
    // Fallback: fetch card JSON from Scryfall to get image URI
    let cancelled = false
    fetch(`https://api.scryfall.com/cards/${card.scryfall_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data) return
        const uri = data.image_uris?.small ?? data.card_faces?.[0]?.image_uris?.small ?? null
        if (uri) setSrc(uri)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [card.scryfall_id, card.image_uris])

  const dims = size === 'lg' ? 'w-16 h-24' : 'w-14 h-20'

  if (!src) {
    return (
      <div className={`${dims} bg-gray-100 dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded flex items-center justify-center flex-shrink-0`}>
        <span className="text-gray-400 dark:text-gray-600 text-xs">?</span>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={card.name}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      className={`${dims} object-contain rounded-dbb-md flex-shrink-0 transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
    />
  )
}

function AddForm({ edition, cardName, binders, onAdd, onBack, adding }) {
  const [binderId, setBinderId] = useState(binders.find(b => b.is_default)?.id || binders[0]?.id || '')
  const [foil, setFoil] = useState('normal')
  const [condition, setCondition] = useState('NM')
  const [quantity, setQuantity] = useState(1)

  // Available foil finishes from catalog data
  const finishes = edition.finishes || ['nonfoil', 'foil']
  const hasFoil = finishes.includes('foil')
  const hasEtched = finishes.includes('etched')

  const card = {
    scryfall_id: edition.scryfall_id,
    name: cardName,
    set_name: edition.set_name,
    set_code: edition.set_code,
    collector_number: edition.collector_number,
    rarity: edition.rarity,
    image_uris: edition.image_uris,
    finishes: edition.finishes,
  }

  return (
    <div className="space-y-4">
      {/* Card summary */}
      <div className="flex gap-3 p-3 bg-gray-50 dark:bg-dbb-secondary/50 rounded-lg border border-gray-200 dark:border-gray-700/50">
        <CardImage card={card} size="lg" />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 dark:text-white truncate">{cardName}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">{card.set_name} · {card.set_code?.toUpperCase()} #{card.collector_number}</p>
          {card.rarity && (
            <span className={`text-xs capitalize ${RARITY_COLORS[card.rarity] || 'text-gray-400'}`}>
              {card.rarity}
            </span>
          )}
        </div>
      </div>

      {/* Binder */}
      <div>
        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Add to binder</label>
        <select
          value={binderId}
          onChange={e => setBinderId(e.target.value)}
          className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-3 text-dbb-sm focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
        >
          {binders.map(b => (
            <option key={b.id} value={b.id}>{b.name}{b.is_default ? ' (default)' : ''}</option>
          ))}
        </select>
      </div>

      {/* Condition */}
      <div>
        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Condition</label>
        <select
          value={condition}
          onChange={e => setCondition(e.target.value)}
          className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-3 text-dbb-sm focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
        >
          {CONDITIONS.map(c => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {/* Foil */}
      <div>
        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Printing</label>
        <div className="flex gap-2">
          <button
            onClick={() => setFoil('normal')}
            className={`flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border text-dbb-sm transition-colors ${foil === 'normal' ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
          >
            Non-foil
          </button>
          {hasFoil && (
            <button
              onClick={() => setFoil('foil')}
              className={`flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border text-dbb-sm transition-colors ${foil === 'foil' ? 'border-yellow-500 bg-yellow-500/10 text-yellow-400' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
            >
              Foil
            </button>
          )}
          {hasEtched && (
            <button
              onClick={() => setFoil('etched')}
              className={`flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border text-dbb-sm transition-colors ${foil === 'etched' ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
            >
              Etched
            </button>
          )}
        </div>
      </div>

      {/* Quantity */}
      <div>
        <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Quantity</label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setQuantity(q => Math.max(1, q - 1))}
            className="flex h-11 w-11 items-center justify-center rounded-dbb-md border border-gray-200 text-lg transition-colors hover:border-dbb-accent hover:text-gray-900 dark:border-gray-700 dark:text-gray-400 dark:hover:text-white"
          >
            −
          </button>
          <input
            type="number"
            min={1}
            max={9999}
            value={quantity}
            onChange={e => setQuantity(Math.min(9999, Math.max(1, parseInt(e.target.value) || 1)))}
            className="h-11 w-16 rounded-dbb-md border border-gray-200 bg-white text-center text-dbb-sm focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
          />
          <button
            onClick={() => setQuantity(q => Math.min(9999, q + 1))}
            className="flex h-11 w-11 items-center justify-center rounded-dbb-md border border-gray-200 text-lg transition-colors hover:border-dbb-accent hover:text-gray-900 dark:border-gray-700 dark:text-gray-400 dark:hover:text-white"
          >
            +
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button
          onClick={onBack}
          disabled={adding}
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-dbb-md border border-gray-200 text-dbb-sm text-gray-500 transition-colors hover:border-gray-300 hover:text-white disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600"
        >
          ← Back
        </button>
        <button
          onClick={() => onAdd({ scryfall_id: card.scryfall_id, binder_id: binderId, quantity, foil, condition })}
          disabled={adding || !binderId}
          className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-dbb-md bg-dbb-accent text-dbb-sm font-semibold text-white transition-colors hover:bg-dbb-accent-hov disabled:opacity-50"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add to library
        </button>
      </div>
    </div>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────
function FilterBar({ filters, setFilters, onApply }) {
  const [expanded, setExpanded] = useState(false)

  const toggleColor = (c) => {
    const current = new Set(filters.colors)
    if (current.has(c)) current.delete(c)
    else current.add(c)
    setFilters({ ...filters, colors: Array.from(current) })
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        <Filter className="w-3.5 h-3.5" />
        Filters {expanded ? <ChevronDown className="w-3 h-3 rotate-180" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {expanded && (
        <div className="space-y-3 p-3 bg-gray-50 dark:bg-dbb-secondary/50 rounded-lg border border-gray-200 dark:border-gray-700/50">
          {/* Set code */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Set code</label>
            <input
              type="text"
              placeholder="e.g. fin, dmh"
              value={filters.set}
              onChange={e => setFilters({ ...filters, set: e.target.value })}
              className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-2.5 text-dbb-xs focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
            />
          </div>

          {/* Rarity */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Rarity</label>
            <select
              value={filters.rarity}
              onChange={e => setFilters({ ...filters, rarity: e.target.value })}
              className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white px-2.5 text-dbb-xs focus:border-dbb-accent focus:outline-none dark:border-gray-700 dark:bg-dbb-secondary"
            >
              {RARITY_OPTIONS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {/* Colors */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Colors</label>
            <div className="flex gap-1">
              {COLOR_OPTIONS.map(c => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => toggleColor(c.value)}
                  title={c.title}
                  className={`flex h-11 w-11 items-center justify-center rounded-dbb-md text-dbb-xs font-bold border transition-colors ${
                    filters.colors.includes(c.value)
                      ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                      : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Mana value range */}
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Mana value range</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="0.5"
                placeholder="min"
                value={filters.cmcMin}
                onChange={e => setFilters({ ...filters, cmcMin: e.target.value })}
                className="w-20 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs focus:border-dbb-accent focus:outline-none"
              />
              <span className="text-xs text-gray-400">–</span>
              <input
                type="number"
                min="0"
                step="0.5"
                placeholder="max"
                value={filters.cmcMax}
                onChange={e => setFilters({ ...filters, cmcMax: e.target.value })}
                className="w-20 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs focus:border-dbb-accent focus:outline-none"
              />
            </div>
          </div>

          {/* Foil only */}
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.foilOnly}
              onChange={e => setFilters({ ...filters, foilOnly: e.target.checked })}
              className="rounded border-gray-300 dark:border-gray-700 text-dbb-accent focus:ring-dbb-accent"
            />
            Foil available only
          </label>

          <div className="pt-1 border-t border-gray-200 dark:border-gray-700/50">
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
              Filter changes stay staged until you confirm them.
            </p>
            <button
              type="button"
              onClick={() => onApply()}
              className="w-full py-2 text-xs btn-primary rounded-lg flex items-center justify-center gap-1.5"
            >
              <Search className="w-3.5 h-3.5" />
              Apply filters
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Edition row within a card group ──────────────────────────────────────
// Which scan evidence this printing agreed with. `null` means the scan
// carried no such evidence, which is neutral — never shown as a mismatch.
function ScanEvidenceChips({ matches }) {
  if (!matches) return null
  const hits = []
  if (matches.set === true) hits.push('set')
  if (matches.collector === true) hits.push('number')
  if (matches.rarity === true) hits.push('rarity')
  if (hits.length === 0) return null
  return (
    <span className="text-xs text-dbb-accent">
      scan match: {hits.join(' · ')}
    </span>
  )
}

function EditionRow({ edition, cardName, onSelect, disabled = false, showCardName = false, languageHeading = null }) {
  return (
    <>
    {languageHeading && <h4 className="pt-2 text-xs font-semibold">{languageHeading}</h4>}
    <button
      onClick={() => onSelect(edition, cardName)}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-dbb-secondary/70 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-colors text-left"
    >
      <CardImage card={{ scryfall_id: edition.scryfall_id, image_uris: edition.image_uris }} />
      <div className="flex-1 min-w-0">
        {showCardName && <CandidateCardName cardName={cardName} />}
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {edition.set_name} · {edition.set_code?.toUpperCase()} #{edition.collector_number}
        </p>
        <div className="flex items-center gap-2">
          {edition.rarity && (
            <span className={`text-xs capitalize ${RARITY_COLORS[edition.rarity] || 'text-gray-400'}`}>
              {edition.rarity}
            </span>
          )}
          {edition.finishes && edition.finishes.length > 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {edition.finishes.join(' / ')}
            </span>
          )}
          <ScanEvidenceChips matches={edition.scanMatches} />
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-600 flex-shrink-0" />
    </button>
    </>
  )
}

// ─── Card group (name + all editions) ─────────────────────────────────────
function CardGroup({ group, onSelect, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const editionCount = group.editions.length

  // Show first edition thumbnail as the group preview
  const firstEdition = group.editions[0]

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700/50 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 p-2.5 hover:bg-gray-100 dark:hover:bg-dbb-secondary/50 transition-colors text-left"
      >
        <CardImage card={{ scryfall_id: firstEdition.scryfall_id, image_uris: firstEdition.image_uris }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{group.name}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {editionCount} edition{editionCount !== 1 ? 's' : ''}
            {group.type_line && ` · ${group.type_line}`}
          </p>
        </div>
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-400 rotate-180 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />}
      </button>

      {expanded && (
        <div className="space-y-0.5 px-2 pb-2 border-t border-gray-200 dark:border-gray-700/50 pt-2">
          {group.editions.map(ed => (
            <EditionRow key={ed.scryfall_id} edition={ed} cardName={group.name} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

const INITIAL_FILTERS = {
  set: '',
  rarity: '',
  colors: [],
  cmcMin: '',
  cmcMax: '',
  foilOnly: false,
}

function hasActiveFilters(filters) {
  return Boolean(
    filters.set.trim() ||
    filters.rarity ||
    filters.colors.length ||
    filters.cmcMin !== '' ||
    filters.cmcMax !== '' ||
    filters.foilOnly
  )
}

function mergeSearchGroups(previous, incoming) {
  const map = new Map((previous || []).map(group => [
    group.name,
    { ...group, editions: [...(group.editions || [])] },
  ]))
  for (const group of incoming || []) {
    if (!map.has(group.name)) {
      map.set(group.name, { ...group, editions: [...(group.editions || [])] })
      continue
    }
    const existing = map.get(group.name)
    const seenIds = new Set(existing.editions.map(edition => edition.scryfall_id))
    for (const edition of group.editions || []) {
      if (!seenIds.has(edition.scryfall_id)) existing.editions.push(edition)
    }
  }
  return [...map.values()]
}

export default function AddCardModal({ binders = [], onClose, onAdded }) {
  // ─── Search state ──────────────────────────────────────────────────────
  const [q, setQ] = useState('')                    // input value (typing — zero requests)
  const [committedQ, setCommittedQ] = useState('')  // query actually submitted to the API
  const [filters, setFilters] = useState({ ...INITIAL_FILTERS })
  const [appliedFilters, setAppliedFilters] = useState({ ...INITIAL_FILTERS }) // filters used in the last committed search
  const [groups, setGroups] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedEdition, setSelectedEdition] = useState(null)  // { edition, cardName }
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)
  const [showScanner, setShowScanner] = useState(false)
  const [scanEvidence, setScanEvidence] = useState(null)
  const [scannerDecision, setScannerDecision] = useState(null)
  const [scannerVisualStatus, setScannerVisualStatus] = useState(null)
  const [scannerShelf, setScannerShelfState] = useState([])
  const [scannerRecovery, setScannerRecovery] = useState(false)
  // A close the shelf guard stopped, and scans held outside scanner mode. Both
  // exist so a pending scan session is never lost without being shown first.
  const [pendingExit, setPendingExit] = useState(null)
  const [heldScans, setHeldScans] = useState(null)
  const [scannerResumeToken, setScannerResumeToken] = useState(0)
  const [scannerBinderId, setScannerBinderId] = useState(
    binders.find(binder => binder.is_default)?.id || binders[0]?.id || ''
  )
  const [scannerCondition, setScannerCondition] = useState('NM')

  // ─── Refs ──────────────────────────────────────────────────────────────
  const inputRef = useRef(null)
  const abortRef = useRef(null)           // AbortController for in-flight search
  const searchGenRef = useRef(0)          // generation counter for staleness protection
  const scannerBatchPendingRef = useRef(false)
  const scannerBatchLifecycleRef = useRef(createScannerBatchLifecycle())
  const scannerCaptureLifecycleRef = useRef(createScannerCaptureLifecycle())
  const scannerShelfRef = useRef([])
  const [printingList, setPrintingList] = useState(null)
  const [printingEditId, setPrintingEditId] = useState(null)
  const [shelfUndo, setShelfUndo] = useState(null)
  const lastScannerSetRef = useRef('')
  const [scanningLanguage, setScanningLanguage] = useState('en')
  const [scannerSetLock, setScannerSetLock] = useState('')
  // Synchronous shelf ownership prevents stale queued confirmations from seeing
  // rows already settled locally, before React has rendered the new shelf.
  const setScannerShelf = useCallback((value) => {
    const next = typeof value === 'function' ? value(scannerShelfRef.current) : value
    scannerShelfRef.current = next
    setShelfUndo(null)
    setScannerShelfState(next)
  }, [])
  const scannerSessionMutable = useCallback(() => scannerBatchLifecycleRef.current.canMutate(), [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!scannerBinderId && binders.length > 0) {
      setScannerBinderId(binders.find(binder => binder.is_default)?.id || binders[0].id)
    }
  }, [binders, scannerBinderId])

  const resumeScanner = useCallback(() => {
    if (!scannerSessionMutable()) return
    scannerCaptureLifecycleRef.current.retire()
    setScanEvidence(null)
    setScannerDecision(null)
    setPrintingList(null)
    setPrintingEditId(null)
    setScannerVisualStatus(null)
    setGroups([])
    setTotal(0)
    setHasMore(false)
    setCommittedQ('')
    setQ('')
    setHeldScans(null)
    setShowScanner(true)
    setScannerResumeToken(token => token + 1)
  }, [scannerSessionMutable])

  // Leaving scanner mode hides the shelf but never discards it. The guard says
  // what is still held so the banner can offer it back instead of the pending
  // scans simply disappearing from view.
  const leaveScannerMode = useCallback((exit) => {
    if (!scannerSessionMutable()) return
    scannerCaptureLifecycleRef.current.retire()
    const outcome = resolveScannerExit({ exit, shelf: scannerShelfRef.current })
    setHeldScans(outcome.kind === 'preserve' ? outcome : null)
    setPendingExit(null)
    setShowScanner(false)
  }, [scannerSessionMutable, scannerShelf])

  const acceptScannerCandidate = useCallback((candidate, source, captureToken) => {
    if (!scannerSessionMutable()) return
    if (!['scanner-direct', 'scanner-confirmed'].includes(source)) return
    if (!candidate?.edition?.scryfall_id) return
    if (!scannerCaptureLifecycleRef.current.consume(captureToken)) return
    setScannerShelf(current => addScannerShelfItem(current, {
      source,
      cardName: candidate.cardName,
      edition: candidate.edition,
      printingUnverified: candidate.printingUnverified === true,
    }))
    lastScannerSetRef.current = candidate.edition.set_code || lastScannerSetRef.current
    resumeScanner()
  }, [resumeScanner, scannerSessionMutable, setScannerShelf])

  const loadPrintingList = async (name, preferredId, append = false, editId = null) => {
    if (!scannerSessionMutable()) return
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const gen = ++searchGenRef.current
    setLoadingMore(true)
    try {
      const ev = scanEvidence || {}
      const params = new URLSearchParams({ name, preferred: preferredId || '', language: scanningLanguage, set_lock: scannerSetLock, last_set: lastScannerSetRef.current, set: ev.setCode || '', collector: ev.collectorNumber || '' })
      if (append && printingList?.cursor) params.set('cursor', printingList.cursor)
      const res = await fetch(`/api/catalog/printings?${params}`, { signal: controller.signal })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Printing lookup failed')
      if (gen !== searchGenRef.current || !scannerSessionMutable()) return
      const editions = data.groups.flatMap(group => group.editions)
      const candidates = [...(append ? scannerDecision?.candidates || [] : []), ...editions.map(edition => ({cardName:name,edition}))]
      setPrintingList({name,preferredId,cursor:data.next_cursor})
      if (editId) setPrintingEditId(editId)
      setScannerDecision({kind:'uncertain',reason:'printing-tie',candidates})
      setHasMore(data.has_more)
    } catch (error) { if (error.name !== 'AbortError' && gen === searchGenRef.current) setError(error.message) }
    finally { if (gen === searchGenRef.current) setLoadingMore(false) }
  }
  const openPrintingEditor = shelfId => {
    const row = scannerShelfRef.current.find(item => item.shelfId === shelfId)
    if (row) loadPrintingList(row.cardName, row.scryfallId, false, shelfId)
  }
  const undoShelfEdit = () => {
    if (!scannerSessionMutable() || !shelfUndo) return
    setScannerShelf(shelfUndo)
  }

  // ─── Build the search URL from query + filters ─────────────────────────
  const buildSearchUrl = useCallback((searchQ, searchFilters, pageNum, limit = DEFAULT_LIMIT, scan = false, scannerEvidence = null) => {
    const params = new URLSearchParams()
    params.set('q', searchQ)
    params.set('limit', String(limit))
    params.set('page', String(pageNum))
    params.set('group', '1')
    // OCR-tolerant name retrieval is scanner-only: a manual search keeps its
    // exact substring semantics.
    if (scan) params.set('scan', '1')
    if (scan && !searchQ && /^\d{1,4}[a-z]?$/i.test(scannerEvidence?.collectorNumber || '')) {
      params.set('collector_number', scannerEvidence.collectorNumber.toLowerCase())
    }
    if (searchFilters.set) params.set('set', searchFilters.set.trim().toLowerCase())
    if (searchFilters.rarity) params.set('rarity', searchFilters.rarity)
    if (searchFilters.colors.length > 0) params.set('color', searchFilters.colors.join(''))
    if (searchFilters.cmcMin !== '' && !isNaN(parseFloat(searchFilters.cmcMin))) params.set('cmc_min', searchFilters.cmcMin)
    if (searchFilters.cmcMax !== '' && !isNaN(parseFloat(searchFilters.cmcMax))) params.set('cmc_max', searchFilters.cmcMax)
    if (searchFilters.foilOnly) params.set('foil_only', '1')
    return `/api/catalog/search?${params.toString()}`
  }, [])

  // ─── Submit search (Enter or Search button) ────────────────────────────
  const doSearch = useCallback(async (
    searchQ,
    searchFilters,
    pageNum = 1,
    append = false,
    evidence = null,
    limit = DEFAULT_LIMIT
  ) => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort()
    }
    // Increment generation so stale responses are ignored
    const gen = ++searchGenRef.current
    const controller = new AbortController()
    abortRef.current = controller

    if (!append) {
      setGroups([])
      setTotal(0)
      setHasMore(false)
      setPage(1)
    }
    setLoading(!append)
    setLoadingMore(append)
    setError(null)

    try {
      // A scan sweeps a bounded number of pages into one candidate pool, so the
      // printing it describes stays reachable past the first page of a broad
      // catalog match. Ordinary and append searches fetch exactly one page.
      let pool = append ? groups : []
      let currentPage = pageNum
      let pagesFetched = 0
      let ranked = []
      let lastTotal = 0
      let lastHasMore = false
      let decision = null
      let routingEvidence = evidence

      for (;;) {
        const url = buildSearchUrl(searchQ, searchFilters, currentPage, limit, Boolean(evidence), evidence)
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || 'Search failed')
        }
        const data = await res.json()

        // Ignore stale responses — only accept if our generation is still current
        if (gen !== searchGenRef.current) return

        pool = mergeSearchGroups(pool, data.groups || [])
        pagesFetched += 1
        ranked = evidence ? rankScannerResults(pool, evidence) : pool
        lastTotal = data.total ?? 0
        lastHasMore = data.has_more ?? false

        if (!evidence || append) break
        decision = routeScannerMatch(ranked, evidence)
        if (!shouldSweepAnotherScanPage({ pagesFetched, hasMore: lastHasMore, decision, evidence })) break
        currentPage += 1
      }

      if (evidence && !append && evidence.nameQuery?.trim()) {
        const printingEvidence = { ...evidence, nameQuery: '' }
        const printingSeed = scannerRetrievalSeed(printingEvidence)
        const initialDecision = routeScannerMatch(ranked, evidence)
        if (printingSeed?.set && ['no-candidates', 'strong-name-required', 'card-name-tie'].includes(initialDecision.reason)) {
          // A weak OCR title can retrieve unrelated names. When both printed
          // identifiers are available, replace that broad pool with an exact
          // set/collector lookup and keep it confirmation-only.
          const printingFilters = { ...searchFilters, set: printingSeed.set }
          const url = buildSearchUrl('', printingFilters, 1, limit, true, printingEvidence)
          const res = await fetch(url, { signal: controller.signal })
          if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            throw new Error(data.error || 'Printing lookup failed')
          }
          const data = await res.json()
          if (gen !== searchGenRef.current) return
          pool = mergeSearchGroups([], data.groups || [])
          ranked = rankScannerResults(pool, printingEvidence)
          lastTotal = data.total ?? 0
          lastHasMore = data.has_more ?? false
          currentPage = 1
          routingEvidence = printingEvidence
          setScanEvidence(printingEvidence)
          setQ('')
          setCommittedQ('')
          setFilters(printingFilters)
          setAppliedFilters(printingFilters)
        }
      }

      if (evidence && !append) {
        const initial = routeScannerMatch(ranked, routingEvidence)
        const identified = initial.candidates?.[0]
        const oneIdentity = identified && initial.candidates.every(c => c.cardName === identified.cardName)
        if (initial.kind !== 'direct' && oneIdentity && !['strong-name-required', 'no-candidates', 'card-name-tie', 'printing-only'].includes(initial.reason)) {
          const params = new URLSearchParams({ name: identified.cardName, language: routingEvidence.languagePrior || 'en', set_lock: routingEvidence.setLock || '', last_set: routingEvidence.lastSet || '', set: routingEvidence.setCode || '', collector: routingEvidence.collectorNumber || '' })
          const response = await fetch(`/api/catalog/printings?${params}`, { signal: controller.signal })
          const family = await response.json()
          if (!response.ok) throw new Error(family.error || 'Printing lookup failed')
          if (gen !== searchGenRef.current || !scannerSessionMutable()) return
          ranked = rankScannerResults(family.groups, routingEvidence)
          lastTotal = family.total
          lastHasMore = family.has_more
          setPrintingList({name:identified.cardName,preferredId:'',cursor:family.next_cursor})
          decision = routeScannerMatch(ranked, routingEvidence, {completeIdentity: !family.has_more, language:routingEvidence.languagePrior})
        }
      }
      if (evidence) {
        // Visual comparison is a local tie-breaker only. A unique OCR/printing
        // decision keeps its existing path; uncertain candidates may be reordered
        // without changing scanScore or the direct/uncertain gate.
        decision = decision || routeScannerMatch(ranked, routingEvidence)
        if (decision.kind !== 'direct') {
          setScannerVisualStatus({ status: 'checking' })
          const visual = await compareScannerCandidatesVisually(ranked, routingEvidence.visualSignature)
          if (gen !== searchGenRef.current) return
          ranked = visual.groups
          decision = routeScannerMatch(ranked, routingEvidence)
          setScannerVisualStatus(visual)
        }

        // Auto-add stays tied to the scan-time decision over the swept pool. A
        // user-triggered page load only widens the list they are choosing from.
        if (!append && decision.kind === 'direct') {
          acceptScannerCandidate(decision.candidate, 'scanner-direct', evidence.captureToken)
          return
        }
        if (append) {
          // decision was just re-derived above from the widened pool via the
          // same routeScannerMatch call the initial scan used, so its
          // candidates are already narrowed to the identified card -- reuse
          // them instead of re-flattening the raw, unfiltered pool, which
          // would reintroduce unrelated cards the initial narrowing excluded.
          //
          // Every decision kind carries that narrowed list, including 'direct'.
          // That matters most exactly when the page the user just loaded is the
          // one holding the printing they scanned: the decision flips to
          // 'direct', and skipping the update here would leave the picker on
          // the older, narrower list with the new printing unreachable. The
          // kind still gates auto-add above; it must not gate visibility.
          setScannerDecision(current => (
            current
              ? { ...current, reason: scannerSelectionReason(decision), candidates: decision.candidates }
              : current
          ))
        } else {
          setScannerDecision(decision)
        }
      }

      setGroups(ranked)
      setTotal(lastTotal)
      setHasMore(lastHasMore)
      setPage(currentPage)
    } catch (e) {
      if (e.name === 'AbortError') return  // cancelled — ignore silently
      if (gen !== searchGenRef.current) return  // stale — ignore
      setError(e.message || 'Search failed. Please try again.')
      if (!append) {
        setGroups([])
        setTotal(0)
        setHasMore(false)
      }
    } finally {
      if (gen === searchGenRef.current) {
        setLoading(false)
        setLoadingMore(false)
        if (abortRef.current === controller) {
          abortRef.current = null
        }
      }
    }
  }, [acceptScannerCandidate, buildSearchUrl, groups])

  // ─── Input handler — typing only, zero requests ────────────────────────
  const handleInput = (e) => {
    setQ(e.target.value)
    // Do NOT search here. User must press Enter or click Search.
  }

  // ─── Submit on Enter ───────────────────────────────────────────────────
  const handleSubmit = (e) => {
    e?.preventDefault?.()
    if (showScanner) return
    const term = q.trim()
    if (!term && !hasActiveFilters(filters)) {
      setGroups([])
      setTotal(0)
      setHasMore(false)
      setCommittedQ('')
      return
    }
    setCommittedQ(term)
    setAppliedFilters({ ...filters })
    setScanEvidence(null)
    setScannerDecision(null)
    setScannerVisualStatus(null)
    setShowScanner(false)
    doSearch(term, filters, 1, false, null, DEFAULT_LIMIT)
  }

  // ─── Load more (next page) ─────────────────────────────────────────────
  const handleLoadMore = () => {
    if (!scannerSessionMutable()) return
    if (loadingMore || !hasMore) return
    if (printingList) { loadPrintingList(printingList.name, printingList.preferredId, true); return }
    doSearch(committedQ, appliedFilters, page + 1, true, scanEvidence, scanEvidence ? SCAN_LIMIT : DEFAULT_LIMIT)
  }

  // ─── Clear — resets everything and cancels in-flight ───────────────────
  const handleClear = () => {
    if (!scannerSessionMutable()) return
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    searchGenRef.current++  // invalidate any in-flight response
    setQ('')
    setCommittedQ('')
    setFilters({ ...INITIAL_FILTERS })
    setAppliedFilters({ ...INITIAL_FILTERS })
    setGroups([])
    setTotal(0)
    setPage(1)
    setHasMore(false)
    setSelectedEdition(null)
    setError(null)
    setScanEvidence(null)
    setScannerDecision(null)
    setScannerVisualStatus(null)
    leaveScannerMode('clear')
    setLoading(false)
    setLoadingMore(false)
    inputRef.current?.focus()
  }

  const handleScanEvidence = (evidence) => {
    if (!scannerSessionMutable()) return
    evidence = { ...evidence, languagePrior: scanningLanguage, setLock: scannerSetLock, lastSet: lastScannerSetRef.current }
    const seed = scannerRetrievalSeed(evidence)
    if (!seed) return
    if (!scannerCaptureLifecycleRef.current.activate(evidence.captureToken)) return
    // Keep catalog retrieval broad. OCR set/rarity reads are ranking signals,
    // not hard filters; a noisy read must not hide the correct card entirely.
    // Only an unreadable title's set+serial fallback browses a set. Ordinary
    // title reads keep the existing broad, clue-ranked candidate pool.
    const nextFilters = { ...INITIAL_FILTERS, set: seed.set }
    const term = seed.query
    setShowScanner(true)
    setScanEvidence(evidence)
    setScannerDecision(null)
    setScannerVisualStatus(evidence.visualSignature ? { status: 'checking' } : { status: 'unavailable' })
    setQ(term)
    setCommittedQ(term)
    setFilters(nextFilters)
    setAppliedFilters(nextFilters)
    setError(null)
    if (term || hasActiveFilters(nextFilters)) {
      return doSearch(term, nextFilters, 1, false, evidence, SCAN_LIMIT)
    }
  }

  const handleManualFallback = (prefill = '') => {
    if (!scannerSessionMutable()) return
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    searchGenRef.current++
    setLoading(false)
    setLoadingMore(false)
    leaveScannerMode('manual')
    setScanEvidence(null)
    setScannerDecision(null)
    setScannerVisualStatus(null)
    setQ(prefill || '')
    setError(null)
    inputRef.current?.focus()
  }

  // Ends the modal outright. Only reached once the shelf is settled — either it
  // was empty, already written, or explicitly discarded.
  const closeNow = useCallback(() => {
    scannerBatchLifecycleRef.current.invalidate()
    scannerCaptureLifecycleRef.current.retire()
    if (abortRef.current) abortRef.current.abort()
    searchGenRef.current++
    setShowScanner(false)
    setPendingExit(null)
    setHeldScans(null)
    terminateScannerWorker()
    onClose()
  }, [onClose])

  // Every way out of the modal — the X button, Escape, the backdrop — arrives
  // here. Closing destroys the temporary shelf, so a non-empty one stops the
  // close once and asks rather than discarding a scan session silently.
  const handleClose = useCallback(() => {
    if (scannerBatchLifecycleRef.current.unknownSnapshot()) {
      setScannerRecovery(true)
      return
    }
    const outcome = resolveScannerBatchExit({
      batchPending: scannerBatchPendingRef.current,
      exit: 'close',
      shelf: scannerShelfRef.current,
    })
    if (outcome.kind === 'blocked') return
    if (outcome.kind === 'confirm') {
      setPendingExit(outcome)
      return
    }
    closeNow()
  }, [closeNow, scannerShelf])

  const confirmScannerDiscard = useCallback(() => {
    if (scannerBatchLifecycleRef.current.unknownSnapshot()) {
      scannerBatchLifecycleRef.current.discard()
      setScannerRecovery(false)
      setScannerShelf([])
      closeNow()
      return
    }
    const outcome = resolveScannerBatchExit({
      batchPending: scannerBatchPendingRef.current,
      exit: 'close',
      shelf: scannerShelfRef.current,
      discardConfirmed: true,
    })
    if (outcome.kind === 'blocked') return
    if (outcome.kind === 'discard') {
      scannerBatchLifecycleRef.current.discard()
      setScannerShelf([])
    }
    closeNow()
  }, [closeNow, setScannerShelf])

  const openScanner = () => {
    if (!scannerSessionMutable()) return
    scannerCaptureLifecycleRef.current.retire()
    setScanEvidence(null)
    setScannerDecision(null)
    setScannerVisualStatus(null)
    setShowScanner(true)
  }

  const editScannerShelf = (shelfId, patch) => {
    if (!scannerSessionMutable()) return
    const before = scannerShelfRef.current
    setScannerShelf(editScannerShelfItem(before, shelfId, patch))
    setShelfUndo(before)
  }

  const removeScannerShelf = (shelfId) => {
    if (!scannerSessionMutable()) return
    setScannerShelf(current => removeScannerShelfItem(current, shelfId))
  }

  const changeScannerBinder = (value) => {
    if (!scannerSessionMutable()) return
    setScannerBinderId(value)
  }

  const changeScannerCondition = (value) => {
    if (!scannerSessionMutable()) return
    setScannerCondition(value)
  }

  const handleScannerBatchAdd = async (retry = false) => {
    if (retry !== true && !scannerSessionMutable()) return
    const payload = retry === true ? scannerBatchLifecycleRef.current.unknownSnapshot() : buildScannerBatchPayload(scannerShelfRef.current, {
      binderId: scannerBinderId,
      condition: scannerCondition,
    })
    if (!payload) {
      setError('Choose a binder and select at least one scanned card before confirming.')
      return
    }

    // Synchronous ownership includes the immutable submitted identities and
    // remains held through body parsing, shelf settlement, and onAdded.
    const request = retry === true ? scannerBatchLifecycleRef.current.retry() : scannerBatchLifecycleRef.current.begin(payload)
    if (!request) return
    scannerCaptureLifecycleRef.current.retire()
    scannerBatchPendingRef.current = true
    setPendingExit(null)
    setAdding(true)
    setError(null)

    let res
    try {
      res = await fetch('/api/library/add/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request.snapshot, batchId: request.batchId }),
      })
    } catch (e) {
      if (!scannerBatchLifecycleRef.current.fail(request)) return
      scannerBatchPendingRef.current = false
      setScannerRecovery(true)
      setError('Inventory may already have changed. This shelf is frozen. Retry the identical batch safely, or check your library manually before continuing.')
      setAdding(false)
      return
    }
    if (!scannerBatchLifecycleRef.current.isCurrent(request)) return
    const data = await parseBatchResponseBody(res)
    if (!scannerBatchLifecycleRef.current.isCurrent(request)) return
    if (res.status >= 400 && res.status < 500) {
      if (!scannerBatchLifecycleRef.current.reject(request)) return
      scannerBatchPendingRef.current = false
      setScannerRecovery(false)
      setError(data.error || 'Could not add scanned cards. Review the batch before confirming again.')
      setAdding(false)
      return
    }
    if (classifyBatchResponse({ ok: res.ok, data, requested: payload.cards.length }) !== 'commit') {
      if (!scannerBatchLifecycleRef.current.fail(request)) return
      scannerBatchPendingRef.current = false
      setScannerRecovery(true)
      setError('Inventory may already have changed. This shelf is frozen. Retry the identical batch safely, or check your library manually before continuing.')
      setAdding(false)
      return
    }

    // Only submitted printing+finish identities leave the shelf. Unchecked
    // rows stay available, and the synchronous ref prevents a stale resend.
    setScannerShelf(current => removeSubmittedScannerRows(current, request.snapshot))
    try {
      const count = payload.cards.length
      onAdded?.({
        card_name: `${count} scanned printing${count === 1 ? '' : 's'}`,
        inserted: data.inserted,
        merged: data.merged,
        replayed: data.replayed === true,
      })
    } catch {
      // A consumer callback cannot undo a known write or re-arm its rows.
    }
    if (!scannerBatchLifecycleRef.current.commit(request)) return
    setScannerRecovery(false)
    scannerBatchPendingRef.current = false
    setAdding(false)
  }

  const acknowledgeScannerLibraryCheck = (checked) => {
    if (checked !== true) return
    const snapshot = scannerBatchLifecycleRef.current.unknownSnapshot()
    if (!snapshot) return
    // Continuing is NOT retry consent. Quarantine submitted identities locally
    // before unlocking; unchecked rows remain, including other finishes.
    setScannerShelf(current => removeSubmittedScannerRows(current, snapshot))
    if (!scannerBatchLifecycleRef.current.continueAfterCheck()) return
    scannerBatchPendingRef.current = false
    setScannerRecovery(false)
    setAdding(false)
    setPendingExit(null)
    resumeScanner()
    setError('Submitted cards were removed from this local shelf, not resent. Reconcile any unresolved cards manually in your library.')
  }

  // ─── Add card to library ───────────────────────────────────────────────
  const handleAdd = async (payload) => {
    if (showScanner) return
    setAdding(true)
    setError(null)
    try {
      const res = await fetch('/api/library/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add card')
      onAdded?.({ ...payload, card_name: data.card_name, inserted: data.inserted, merged: data.merged })
      handleClose()
    } catch (e) {
      setError(e.message)
      setAdding(false)
    }
  }

  // ─── Select an edition ─────────────────────────────────────────────────
  const handleSelectEdition = (edition, cardName) => {
    if (!scannerSessionMutable()) return
    if (printingEditId) {
      editScannerShelf(printingEditId, { edition })
      setPrintingEditId(null)
      setPrintingList(null)
      setScannerDecision(null)
      setHasMore(false)
      return
    }
    const destination = routeCatalogSelection({
      scannerOpen: showScanner,
      hasScanEvidence: Boolean(scanEvidence),
    })
    if (destination === 'scanner-shelf') {
      acceptScannerCandidate({ edition, cardName }, 'scanner-confirmed', scanEvidence.captureToken)
      setError(null)
      return
    }
    if (destination === 'blocked') return
    setSelectedEdition({ edition, cardName })
    setError(null)
  }

  // ─── Back navigation on Escape (when in add form) ────────────────────
  // The focus trap hook handles Escape → onClose; this intercepts first
  // when the user is in the edition form to go back to search instead.
  useEffect(() => {
    if (!selectedEdition) return
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedEdition(null)
      }
    }
    // Use capture phase so this fires before the focus trap's keydown
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [selectedEdition])

  // ─── Protect unsaved scanner rows on reload / tab close ────────────────
  useEffect(() => {
    const beforeUnload = (event) => {
      if (pendingShelfSummary(scannerShelfRef.current).rows === 0 && !scannerRecovery) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [scannerRecovery])

  // ─── Cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    // arm() re-mounts the lifecycle on every mount of this effect. React
    // StrictMode double-invokes it (mount -> cleanup -> mount) in dev, and
    // the lifecycle lives in a useRef that survives that, so without this the
    // simulated unmount's invalidate() below would leave it permanently
    // unmounted after the second mount.
    scannerBatchLifecycleRef.current.arm()
    if (scannerBatchLifecycleRef.current.unknownSnapshot()) {
      scannerBatchPendingRef.current = false
      setAdding(false)
      setScannerRecovery(true)
      setError('Inventory may already have changed. This shelf is frozen. Retry the identical batch safely, or check your library manually before continuing.')
    }
    return () => {
      if (abortRef.current) {
        abortRef.current.abort()
      }
      searchGenRef.current++
      scannerBatchLifecycleRef.current.invalidate()
      terminateScannerWorker()
    }
  }, [])

  const sheetRef = useRef(null)
  const closeBtnRef = useRef(null)
  const viewportRef = useRef(null)

  useEffect(() => {
    if (!showScanner || !viewportRef.current) return
    return attachScannerViewport(viewportRef.current)
  }, [showScanner])
  useEffect(() => {
    if (showScanner && (pendingExit || scannerRecovery)) revealScannerNotice(viewportRef.current)
  }, [showScanner, pendingExit, scannerRecovery])
  useFocusTrap(sheetRef, closeBtnRef, handleClose, [selectedEdition, showScanner])

  const scannerNotices = <div data-scanner-notice="">
    {scannerRecovery && (
      <div role="alert" className="mb-3 space-y-2 rounded-dbb-md border border-amber-500 p-3 text-dbb-xs">
        <p>Inventory may already have changed. This shelf is frozen. Check your library manually in another tab before continuing.</p>
        <button type="button" disabled={adding} onClick={() => handleScannerBatchAdd(true)} className="min-h-[44px] w-full rounded-dbb-md border px-3 disabled:opacity-50">Retry the identical batch safely</button>
        <p>Continuing removes submitted cards from this local shelf without resending them. Keep unchecked rows; reconcile unresolved cards manually.</p>
        <button type="button" onClick={() => acknowledgeScannerLibraryCheck(true)} className="min-h-[44px] w-full rounded-dbb-md border px-3">Check my library then continue</button>
        <p>By continuing, I acknowledge that I have checked my library.</p>
        <button type="button" onClick={confirmScannerDiscard} className="min-h-[44px] w-full rounded-dbb-md border px-3">Discard local shelf only — inventory may already have changed</button>
      </div>
    )}
    {pendingExit && !adding && !scannerRecovery && (
      <ScannerExitPrompt
        rows={pendingExit.rows}
        quantity={pendingExit.quantity}
        onKeep={() => setPendingExit(null)}
        onDiscard={confirmScannerDiscard}
      />
    )}
  </div>
  const modal = (
    <div
      ref={viewportRef}
      data-scanner-shell={showScanner ? '' : undefined}
      style={showScanner ? { top: 'var(--scanner-top, 0px)', left: 'var(--scanner-left, 0px)', width: 'var(--scanner-width, 100%)', height: 'var(--scanner-height, 100dvh)', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' } : undefined}
      className={showScanner ? 'fixed inset-0 z-50 flex overflow-hidden bg-white dark:bg-dbb-primary' : 'fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4'}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose() }}
      role="presentation"
    >
      {/* Mobile: full-height bottom sheet. Desktop: centered panel.
          Solid content body; glass chrome only on header. */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={showScanner ? 'Scan cards' : selectedEdition ? 'Add to library' : 'Search card catalog'}
        className={showScanner ? 'relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-white dark:bg-dbb-primary' : 'relative flex h-[92vh] w-full flex-col overflow-hidden rounded-t-dbb-xl bg-white shadow-2xl dark:bg-dbb-primary sm:h-auto sm:max-h-[90vh] sm:max-w-md sm:rounded-dbb-xl'}
      >
        {/* Header — glass chrome */}
        <div className="dbb-glass-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3">
          <h2 className="truncate text-dbb-lg font-semibold tracking-heading text-gray-900 dark:text-white">
            {showScanner ? 'Scan cards' : selectedEdition ? 'Add to library' : 'Search card catalog'}
          </h2>
          <button
            ref={closeBtnRef}
            onClick={handleClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable solid body */}
        <div className={showScanner ? 'min-h-0 flex-1 overflow-hidden p-3' : 'flex-1 overflow-y-auto overscroll-contain p-4'}>
          {!showScanner && scannerNotices}
          {!selectedEdition ? (
            <div className={showScanner ? 'h-full min-h-0' : 'space-y-3'}>
              {!showScanner && (
                <>
                  {/* Search input — explicit submit only */}
                  <form onSubmit={handleSubmit} className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Type a card name, then press Enter or Search"
                  value={q}
                  onChange={handleInput}
                  className="h-11 w-full rounded-dbb-md border border-gray-200 bg-white pl-9 pr-24 text-dbb-sm focus:border-dbb-accent focus:outline-none placeholder-gray-400 dark:border-gray-700 dark:bg-dbb-secondary dark:placeholder-gray-600"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  {q && (
                    <button
                      type="button"
                      onClick={handleClear}
                      className="flex min-h-[36px] items-center px-2 text-dbb-xs text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!q.trim() || loading}
                    className="flex min-h-[36px] items-center gap-1 rounded-dbb-md bg-dbb-accent px-2.5 text-dbb-xs text-white transition-colors hover:bg-dbb-accent-hov disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                    Search
                  </button>
                </div>
                  </form>

                  <button
                    type="button"
                    onClick={openScanner}
                    className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-dbb-md border border-dbb-accent/50 text-dbb-sm text-dbb-accent transition-colors hover:bg-dbb-accent/10"
                  >
                    <ScanLine className="h-4 w-4" />
                    Scan card
                  </button>
                </>
              )}

              {!showScanner && heldScans && (
                <HeldScansBanner
                  rows={heldScans.rows}
                  quantity={heldScans.quantity}
                  onResume={resumeScanner}
                />
              )}

              {showScanner && (
                <CardScannerPanel
                  onEvidence={handleScanEvidence}
                  onManual={handleManualFallback}
                  shelf={scannerShelf}
                  onEditShelfItem={editScannerShelf}
                  onChangePrinting={openPrintingEditor}
                  onUndoShelfEdit={undoShelfEdit}
                  canUndoShelfEdit={Boolean(shelfUndo)}
                  onRemoveShelfItem={removeScannerShelf}
                  binders={binders}
                  binderId={scannerBinderId}
                  onBinderChange={changeScannerBinder}
                  condition={scannerCondition}
                  conditions={CONDITIONS}
                  onConditionChange={changeScannerCondition}
                  onConfirmBatch={handleScannerBatchAdd}
                  confirming={adding}
                  recovery={scannerRecovery}
                  resumeToken={scannerResumeToken}
                  visualStatus={scannerVisualStatus}
                >
                  {scannerNotices}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label>Scanning language<select aria-label="Scanning language" value={scanningLanguage} disabled={adding || scannerRecovery} onChange={event => setScanningLanguage(event.target.value)} className="min-h-[44px] w-full rounded border bg-white text-gray-900">{['en','ja','de','fr','es','it','pt','ko','ru','zhs','zht'].map(lang=><option key={lang} value={lang}>{lang.toUpperCase()}</option>)}</select></label>
                    <label>Set lock<input aria-label="Scanner set lock" value={scannerSetLock} maxLength={5} disabled={adding || scannerRecovery} onChange={event => setScannerSetLock(event.target.value.toLowerCase().replace(/[^a-z0-9]/g,''))} className="min-h-[44px] w-full rounded border bg-white text-gray-900" /></label>
                  </div>
                  {error && <p role="alert" className="text-sm text-red-500 dark:text-red-400">{error}</p>}
                  {loading && scanEvidence && (
                    <div className="flex items-center justify-center gap-2 rounded-dbb-md border border-dbb-accent/30 p-3 text-dbb-xs text-dbb-accent">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Matching scan to catalog…
                    </div>
                  )}
                  {scannerDecision?.kind === 'uncertain' && (
                    <PrintingSelectionPanel
                      reason={scannerDecision.reason}
                      count={scannerDecision.candidates.length}
                      hasMore={hasMore}
                      loadingMore={loadingMore}
                      onLoadMore={handleLoadMore}
                    >
                      {scannerDecision.candidates.map((candidate,index) => (
                        <EditionRow
                          key={candidate.edition.scryfall_id}
                          languageHeading={index === 0 || candidate.edition.lang !== scannerDecision.candidates[index-1].edition.lang ? candidate.edition.lang?.toUpperCase() || 'Language not recorded' : null}
                          showCardName={new Set(scannerDecision.candidates.map(c => c.cardName)).size > 1}
                          edition={candidate.edition}
                          cardName={candidate.cardName}
                          onSelect={handleSelectEdition}
                          disabled={adding || scannerRecovery}
                        />
                      ))}
                    </PrintingSelectionPanel>
                  )}
                </CardScannerPanel>
              )}

              {!showScanner && (
                <>
                  {/* Filters */}
                  <FilterBar filters={filters} setFilters={setFilters} onApply={handleSubmit} />
                </>
              )}

              {scanEvidence && !showScanner && (
                <p className="text-xs text-dbb-accent">
                  Scan-ranked results — {isUsablePrintingEvidence(scanEvidence) ? 'printing clues detected' : 'name match only; confirm the printing'}.
                </p>
              )}

              {error && !showScanner && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

              {/* Results — grouped by card name */}
              {!showScanner && groups.length > 0 && (
                <>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {total} result{total !== 1 ? 's' : ''} for &ldquo;{committedQ}&rdquo;
                  </p>
                  <div className="space-y-2">
                    {groups.map(group => (
                      <CardGroup key={group.name} group={group} onSelect={handleSelectEdition} defaultExpanded={Boolean(scanEvidence)} />
                    ))}
                  </div>

                  {/* Load more */}
                  {hasMore && (
                    <button
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-dbb-md border border-gray-200 text-dbb-sm text-gray-600 transition-colors hover:border-dbb-accent hover:text-dbb-accent disabled:opacity-50 dark:border-gray-700 dark:text-gray-400"
                    >
                      {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronDown className="w-4 h-4" />}
                      Load more
                    </button>
                  )}
                </>
              )}

              {!showScanner && !loading && committedQ && groups.length === 0 && !error && (
                <p className="text-sm text-gray-500 text-center py-6">
                  No cards found for &ldquo;{committedQ}&rdquo;
                </p>
              )}

              {!showScanner && !committedQ && (
                <p className="text-sm text-gray-400 dark:text-gray-600 text-center py-6">
                  Type a card name, then press Enter or click Search to find cards in the catalog
                </p>
              )}
            </div>
          ) : (
            <AddForm
              edition={selectedEdition.edition}
              cardName={selectedEdition.cardName}
              binders={binders}
              onAdd={handleAdd}
              onBack={() => setSelectedEdition(null)}
              adding={adding}
            />
          )}

          {error && selectedEdition && (
            <p className="mt-2 text-sm text-red-500 dark:text-red-400">{error}</p>
          )}
        </div>
      </div>
    </div>
  )
  // Scanner is not a drawer descendant: transformed page/sheet ancestors
  // cannot move its fixed guide. Manual catalog search retains its old sheet.
  return showScanner && typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}
