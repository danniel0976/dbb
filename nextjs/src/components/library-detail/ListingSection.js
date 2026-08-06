'use client'

import { useState, useEffect } from 'react'
import { useToast } from '@/components/Toast'
import { Minus, Plus, Tag, X, Loader2, Package } from 'lucide-react'
import { MULTIPLIERS, DURATION_OPTIONS, relativeTime } from './constants'
import ClaimSaleForm from './ClaimSaleForm'
import { OWNER_LISTING_STATUS } from './priceSummary'

export default function ListingSection({
  libraryRow,
  hasPhoto,
  onRequirePhoto,
  listingState,
  onListingChange,
  onListingUncertain,
}) {
  const { toast } = useToast()
  const [showPicker, setShowPicker] = useState(false)
  const [showListPrompt, setShowListPrompt] = useState(false) // singles vs claim sale
  const [showClaimSale, setShowClaimSale] = useState(false)
  const [isRelist, setIsRelist] = useState(false)
  const [multiplier, setMultiplier] = useState(2.5)
  const [durationHours, setDurationHours] = useState(24)
  const [listQuantity, setListQuantity] = useState(1) // listing quantity (1..owned)
  const [pricePreview, setPricePreview] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [photoRequired, setPhotoRequired] = useState(false)
  const [merchantProfileRequired, setMerchantProfileRequired] = useState(false)

  const ownedQty = libraryRow.quantity || 1

  // Reset listing quantity to 1 when opening a new listing picker
  useEffect(() => {
    if (showPicker) setListQuantity(1)
  }, [showPicker])

  // Fetch price preview when either the new-listing or relist picker is open.
  // Relisting uses isRelist without setting showPicker, so checking only
  // showPicker left every multiplier button without a price.
  useEffect(() => {
    if ((!showPicker && !isRelist) || !libraryRow.scryfall_id) return
    const foil = libraryRow.foil || 'normal'
    fetch('/api/pricing/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ scryfall_id: libraryRow.scryfall_id, foil }] }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const key = `${libraryRow.scryfall_id}:${foil}`
        setPricePreview(data?.prices?.[key]?.ckd_usd ?? null)
      })
      .catch(() => {})
  }, [showPicker, isRelist, libraryRow.scryfall_id, libraryRow.foil])

  const computeMyr = (ckdUsd, mult) => {
    if (ckdUsd == null) return null
    return Math.round(ckdUsd * mult * 2) / 2
  }

  const handleList = async () => {
    setSubmitting(true)
    try {
      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library_card_id: libraryRow.id, multiplier, duration_hours: durationHours, quantity: listQuantity }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 422 && err.missing_photos?.includes(libraryRow.id)) {
          onRequirePhoto?.(handleList)
          return
        }
        if (err.code === 'MERCHANT_PROFILE_REQUIRED' || err.code === 'MERCHANT_PROFILE_UNAVAILABLE') {
          setMerchantProfileRequired(true)
          return
        }
        throw new Error(err.error || 'Failed')
      }
      // Match ClaimSaleForm: the listing exists server-side once we are here, so
      // an unreadable or non-matching response is ambiguous, not a success. It
      // must fail closed into the error state *and* report an error — announcing
      // "Card listed on Bazaar" next to the amber "could not check listing
      // status" panel told the user two contradictory things at once.
      let data
      try {
        data = await res.json()
      } catch {
        onListingChange({ multiplier, status: 'active' })
        setShowPicker(false)
        throw new Error('Card was listed, but its Bazaar listing could not be confirmed')
      }
      const nextListing = Array.isArray(data.listings)
        ? data.listings.find(listing =>
          listing?.id &&
          listing.library_card_id === libraryRow.id &&
          listing.status === 'active'
        )
        : null
      if (!nextListing) {
        onListingChange({ multiplier, status: 'active' })
        setShowPicker(false)
        throw new Error('Card was listed, but its Bazaar listing could not be confirmed')
      }
      onListingChange(nextListing)
      setShowPicker(false)
      toast('Card listed on Bazaar', 'success')
    } catch (e) {
      toast(e.message || 'Failed to list card', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRelist = async () => {
    if (!listing?.id) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/listings/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiplier, duration_hours: durationHours }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (err.code === 'MERCHANT_PROFILE_REQUIRED' || err.code === 'MERCHANT_PROFILE_UNAVAILABLE') {
          setMerchantProfileRequired(true)
          return
        }
        throw new Error(err.error || 'Failed to relist card')
      }
      const data = await res.json()
      const nextListing = data.listing || { ...listing, status: 'active', multiplier }
      onListingChange(nextListing)
      setShowPicker(false)
      setIsRelist(false)
      toast('Card relisted on Bazaar', 'success')
    } catch (error) {
      toast(error.message || 'Failed to relist card', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleUnlist = async () => {
    if (!listing?.id) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/listings/${listing.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      onListingChange(null)
      toast('Card unlisted', 'success')
    } catch {
      toast('Failed to unlist card', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (listingState.status === OWNER_LISTING_STATUS.LOADING) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-600 pt-2 border-t border-black/5">
        <Loader2 className="w-3 h-3 animate-spin" /> Checking bazaar status...
      </div>
    )
  }

  if (listingState.status === OWNER_LISTING_STATUS.ERROR) {
    return (
      <div data-testid="library-detail-listing-error" className="text-xs text-amber-600 pt-2 border-t border-black/5">
        Could not check Bazaar listing status. Close and reopen to try again.
      </div>
    )
  }

  const listing = listingState.status === OWNER_LISTING_STATUS.READY
    ? listingState.listing
    : null

  const isExpired = listing && (
    listing.status === 'expired' ||
    (listing.expires_at && new Date(listing.expires_at) <= new Date())
  )

  // Not listed yet — show a "List on Bazaar" button (not the picker right away)
  if (!listing && !showPicker && !showClaimSale && !showListPrompt) {
    return (
      <div className="pt-2 border-t border-black/5">
        <button
          onClick={() => {
            if (!hasPhoto) {
              setPhotoRequired(true)
              onRequirePhoto?.()
            } else { setShowListPrompt(true) }
          }}
          className="flex items-center justify-center gap-2 w-full py-1.5 border border-gray-200 hover:border-dbb-accent text-gray-500 hover:text-dbb-accent rounded-lg text-xs font-medium transition-colors"
        >
          <Tag className="w-3 h-3" />
          List on Bazaar
        </button>
        {photoRequired && !hasPhoto && (
          <p className="text-xs text-amber-400 mt-1.5">
            Opening the assisted camera so you can add the required condition photo.
          </p>
        )}
      </div>
    )
  }

  // Show listing type prompt: singles or claim sale
  if (showListPrompt && !showPicker && !showClaimSale) {
    return (
      <div className="pt-2 border-t border-black/5 space-y-3">
        <p className="text-xs text-gray-600 font-medium">Sell as singles or put up for claim sale?</p>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowListPrompt(false); setShowPicker(true) }}
            className="flex-1 py-2 border border-gray-200 hover:border-dbb-accent text-gray-600 hover:text-dbb-accent rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            <Tag className="w-3 h-3" /> Singles
          </button>
          <button
            onClick={() => { setShowListPrompt(false); setShowClaimSale(true) }}
            className="flex-1 py-2 border border-gray-200 hover:border-dbb-accent text-gray-600 hover:text-dbb-accent rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            <Package className="w-3 h-3" /> Claim Sale
          </button>
        </div>
        <button
          onClick={() => setShowListPrompt(false)}
          className="text-xs text-gray-500 hover:text-gray-900 transition-colors"
        >
          Cancel
        </button>
      </div>
    )
  }

  // Show claim sale form
  if (showClaimSale) {
    return (
      <ClaimSaleForm
        libraryRow={libraryRow}
        onCancel={() => setShowClaimSale(false)}
        onRequirePhoto={onRequirePhoto}
        onListingCreated={onListingChange}
        onListingUncertain={onListingUncertain}
      />
    )
  }

  // Show picker for new listing or relist
  if (!listing || (showPicker && !isExpired) || (isRelist && isExpired)) {
    const isRelisting = isExpired && isRelist

    // Photo gate — shouldn't happen (button above checks), but block at render level too
    if (!hasPhoto) {
      return (
        <div className="pt-2 border-t border-black/5 space-y-2">
          <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
            A card photo is required before listing. Please take a photo above.
          </p>
          <button
            onClick={() => { setShowPicker(false); setIsRelist(false); setPhotoRequired(false) }}
            className="text-xs text-gray-500 hover:text-gray-900 transition-colors"
          >
            Cancel
          </button>
        </div>
      )
    }

    if (merchantProfileRequired) {
      return (
        <div className="pt-2 border-t border-black/5 space-y-2">
          <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
            Complete your seller payment information in Profile before listing or relisting.
          </p>
          <div className="flex items-center gap-3">
            <a href="/profile" className="text-xs font-medium text-dbb-accent hover:underline">
              Complete seller profile
            </a>
            <button
              onClick={() => { setMerchantProfileRequired(false); setShowPicker(false); setIsRelist(false) }}
              className="text-xs text-gray-500 hover:text-gray-900 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="pt-2 border-t border-black/5">
        <div className="space-y-3">
          <p className="text-xs text-gray-600 font-medium">
            {isRelisting ? 'Relist on Bazaar' : 'List on Bazaar'}
          </p>

          {/* Multiplier picker */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Multiplier</p>
            <div className="flex gap-2">
              {MULTIPLIERS.map(m => {
                const myr = computeMyr(pricePreview, m)
                return (
                  <button
                    key={m}
                    onClick={() => setMultiplier(m)}
                    className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      multiplier === m
                        ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                        : 'border-gray-200 text-gray-500 hover:border-dbb-accent/50'
                    }`}
                  >
                    <div>×{m}</div>
                    {myr != null ? (
                      <div className="text-xs text-gray-500 font-normal">RM {myr.toFixed(2)}</div>
                    ) : (
                      <div className="text-xs text-gray-600 font-normal">—</div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Quantity picker (1..owned) */}
          {ownedQty > 1 && (
            <div>
              <p className="text-xs text-gray-600 mb-1.5">Quantity (max {ownedQty})</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setListQuantity(q => Math.max(1, q - 1))}
                  className="p-1 rounded bg-gray-100 hover:bg-gray-200 transition-colors"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <input
                  type="number"
                  min="1"
                  max={ownedQty}
                  value={listQuantity}
                  onChange={(e) => {
                    const v = parseInt(e.target.value) || 1
                    setListQuantity(Math.max(1, Math.min(ownedQty, v)))
                  }}
                  className="w-16 text-center bg-white border border-gray-200 rounded px-2 py-1 text-sm focus:border-dbb-accent focus:outline-none"
                />
                <button
                  onClick={() => setListQuantity(q => Math.min(ownedQty, q + 1))}
                  className="p-1 rounded bg-gray-100 hover:bg-gray-200 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
                <span className="text-xs text-gray-500 ml-1">of {ownedQty} owned</span>
              </div>
            </div>
          )}

          {/* Duration picker */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Duration (max 24h)</p>
            <div className="flex gap-1.5">
              {DURATION_OPTIONS.map(({ hours, label }) => (
                <button
                  key={hours}
                  onClick={() => setDurationHours(hours)}
                  className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                    durationHours === hours
                      ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent'
                      : 'border-gray-200 text-gray-600 hover:border-gray-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={isRelisting ? handleRelist : handleList}
              disabled={submitting}
              className="flex-1 py-1.5 text-sm bg-dbb-accent hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? 'Listing...' : (isRelisting ? 'Relist' : 'Confirm Listing')}
            </button>
            <button
              onClick={() => { setShowPicker(false); setIsRelist(false) }}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Expired listing state
  const expiredQty = listing.quantity || 1
  if (isExpired) {
    return (
      <div className="pt-2 border-t border-black/5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-xs font-medium text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-0.5">
            <Tag className="w-3 h-3" /> Listing Expired
          </span>
          <button
            onClick={() => { setIsRelist(true); setMultiplier(Number(listing.multiplier) || 2.5); setListQuantity(expiredQty) }}
            className="btn btn-outline btn-sm"
          >
            Relist
          </button>
        </div>
        {expiredQty > 1 && (
          <p className="text-xs text-gray-500 mt-1">{expiredQty} copies</p>
        )}
      </div>
    )
  }

  // Active listing state
  const listedAgo = listing.created_at ? relativeTime(listing.created_at, false) : null
  const expiresIn = listing.expires_at ? relativeTime(listing.expires_at, true) : null
  const listedQty = listing.quantity || 1

  return (
    <div className="pt-2 border-t border-black/5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 border border-green-500/30 rounded px-2 py-0.5">
            <Tag className="w-3 h-3" /> Listed on Bazaar
          </span>
          <span className="text-xs text-gray-500">×{listing.multiplier}{listedQty > 1 ? ` · ${listedQty} copies` : ''}</span>
        </div>
        <button
          onClick={handleUnlist}
          disabled={submitting}
          className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
        >
          {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          Unlist
        </button>
      </div>
      {(listedAgo || expiresIn) && (
        <p className="text-[10px] text-gray-600 mt-1">
          {listedAgo && `listed ${listedAgo}`}
          {listedAgo && expiresIn && ' · '}
          {expiresIn && `expires ${expiresIn}`}
        </p>
      )}
    </div>
  )
}
