// Pure helpers behind the Library card-detail price summary.
//
// The selling figure is CardKingdom's USD baseline × the selected DBB
// multiplier, rounded to the nearest RM 0.50 — the same rounding rule
// `sellPrice` applies in lib/pricingCache.js, which is what /api/pricing/batch,
// listing creation and checkout all price against. The display additionally
// rejects the non-positive result that checkout cannot sell. There is
// deliberately no FX step: the multiplier is the USD→MYR sell rule.
//
// pricingCache.js itself owns the server-side cache singleton, so it must not
// be pulled into a client bundle; only the arithmetic is mirrored here, and
// the focused check asserts the two stay in step.

// Explicit extension so the focused check can import this module under plain
// node, the way the repo's other pure-logic checks run.
import { MULTIPLIERS } from './constants.js'

// Discriminated states the summary can be in. There is no fallback price:
// when CardKingdom has no figure for a printing we say so rather than
// substituting Scryfall or any other source.
export const PRICE_STATUS = {
  LOADING: 'loading',
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
}

// /api/pricing/batch keys its response map by "<scryfall_id>:<foil>".
export function priceCacheKey(scryfallId, foil = 'normal') {
  return `${scryfallId}:${foil || 'normal'}`
}

// Pull the CKD USD baseline out of a batch payload, or null when the printing
// has no cached price (missing key, null value, or a non-finite/negative
// number, all of which mean "we don't have a price" rather than "it's free").
export function readCkdUsd(payload, scryfallId, foil = 'normal') {
  const value = payload?.prices?.[priceCacheKey(scryfallId, foil)]?.ckd_usd
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

// CKD USD × multiplier, rounded to nearest RM 0.50. Checkout treats a
// non-positive result as unavailable, so the display does the same rather than
// presenting RM 0.00 as a sellable amount.
export function sellPriceMyr(ckdUsd, multiplier) {
  if (ckdUsd == null || !Number.isFinite(ckdUsd)) return null
  if (!Number.isFinite(multiplier)) return null
  const rounded = Math.round(ckdUsd * multiplier * 2) / 2
  return rounded > 0 ? rounded : null
}

// Coerce a stored listing multiplier (Postgres numeric arrives as a string)
// onto one of the offered tiers; null when it isn't one of them.
export function normalizeMultiplier(candidate) {
  const value = Number(candidate)
  if (!Number.isFinite(value)) return null
  return MULTIPLIERS.find(m => Math.abs(m - value) < 1e-9) ?? null
}

export function formatUsd(ckdUsd) {
  return ckdUsd == null ? null : `USD $${ckdUsd.toFixed(2)}`
}

export function formatMyr(myr) {
  return myr == null || !Number.isFinite(myr) || myr <= 0 ? null : `RM ${myr.toFixed(2)}`
}

// Only a current, persisted active listing can make the summary authoritative.
// Invalid/legacy multipliers cannot silently fall back while retaining the
// "Sell price" label.
export function activeListingMultiplier(listing, now = Date.now()) {
  if (!listing?.id || listing.status !== 'active') return null
  if (listing.expires_at) {
    const expiresAt = Date.parse(listing.expires_at)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  }
  return normalizeMultiplier(listing.multiplier)
}

// Everything the summary renders, derived in one place so the component stays
// a dumb view and the listing/preview contract is directly testable.
export function buildPriceSummary({ status, ckdUsd, listing, previewMultiplier = MULTIPLIERS[0], now = Date.now() }) {
  const listedTier = activeListingMultiplier(listing, now)
  const authoritative = listedTier != null
  const tier = listedTier ?? normalizeMultiplier(previewMultiplier) ?? MULTIPLIERS[0]
  const presentation = {
    authoritative,
    priceLabel: authoritative ? 'Sell price' : 'Price preview',
    multiplier: tier,
  }

  if (status !== PRICE_STATUS.READY || ckdUsd == null || !Number.isFinite(ckdUsd) || ckdUsd < 0) {
    return {
      ...presentation,
      status: status === PRICE_STATUS.READY ? PRICE_STATUS.UNAVAILABLE : status,
      sellStatus: status === PRICE_STATUS.READY ? PRICE_STATUS.UNAVAILABLE : status,
      baselineLabel: null,
      sellLabel: null,
      myr: null,
    }
  }
  const myr = sellPriceMyr(ckdUsd, tier)
  return {
    ...presentation,
    status: PRICE_STATUS.READY,
    sellStatus: myr == null ? PRICE_STATUS.UNAVAILABLE : PRICE_STATUS.READY,
    baselineLabel: formatUsd(ckdUsd),
    sellLabel: formatMyr(myr),
    myr,
  }
}
