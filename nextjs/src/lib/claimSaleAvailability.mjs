// Buyer-facing availability for a single Claim Sale child listing.
//
// This decides ONLY what the buyer is told and whether the purchase controls
// render. It never relaxes a stock rule: `purchasable` is strictly narrower
// than the previous inline gate (active status, offered quantity > 0, listing
// and sale both unexpired, not the owner), and the authoritative check still
// happens atomically in phase45c_cart_add / checkout_orders. A buyer who is
// shown the controls can still lose the race and get a server-side error.
//
// Offered quantity is listings.quantity — the seller's offered supply for this
// listing. library_cards.quantity is private seller inventory and must never be
// substituted here.

export const AVAILABILITY = {
  PURCHASABLE: 'purchasable',
  MISSING: 'listing_missing',
  OWNER: 'owner',
  SALE_ENDED: 'sale_ended',
  LISTING_ENDED: 'listing_ended',
  RESERVED: 'reserved',
  SOLD_OUT: 'sold_out',
  SIGNED_OUT: 'signed_out',
}

const COPY = {
  [AVAILABILITY.MISSING]: {
    title: 'Listing unavailable',
    detail: 'This card is no longer part of the claim sale.',
  },
  [AVAILABILITY.OWNER]: {
    title: 'Your listing',
    detail: 'You are the seller, so the buyer purchase controls are hidden here.',
  },
  [AVAILABILITY.SALE_ENDED]: {
    title: 'Claim sale has ended',
    detail: 'This claim sale is no longer running, so its cards cannot be added to a cart.',
  },
  [AVAILABILITY.LISTING_ENDED]: {
    title: 'Listing has ended',
    detail: 'This card is no longer offered. The seller can relist it.',
  },
  [AVAILABILITY.RESERVED]: {
    title: 'Reserved by a pending order',
    detail: 'Another buyer has checked out this copy and their order is still open, so it cannot be added to a cart. It returns to the claim sale if that order is cancelled.',
  },
  [AVAILABILITY.SOLD_OUT]: {
    title: 'No copies left',
    detail: 'Every copy the seller offered for this card has been claimed.',
  },
  [AVAILABILITY.SIGNED_OUT]: {
    title: 'Sign in to buy',
    detail: 'Sign in to add this card to your cart.',
  },
}

function timeInFuture(value, now) {
  if (!value) return false
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) && ms > now
}

function timeInPast(value, now) {
  if (!value) return false
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) && ms <= now
}

export function resolveListingAvailability({
  listing,
  claimSaleStatus,
  claimSaleExpiresAt,
  isOwner = false,
  isSignedIn = false,
  now = Date.now(),
} = {}) {
  const build = (code) => ({
    code,
    purchasable: code === AVAILABILITY.PURCHASABLE,
    offeredQuantity: Number.isFinite(Number(listing?.quantity)) ? Number(listing.quantity) : null,
    ...(COPY[code] || { title: null, detail: null }),
  })

  if (!listing) return build(AVAILABILITY.MISSING)
  if (isOwner) return build(AVAILABILITY.OWNER)

  const saleEnded = (claimSaleStatus && claimSaleStatus !== 'active') ||
    timeInPast(claimSaleExpiresAt, now)
  if (saleEnded) return build(AVAILABILITY.SALE_ENDED)

  if (listing.status === 'expired' || listing.status === 'cancelled') {
    return build(AVAILABILITY.LISTING_ENDED)
  }
  if (!timeInFuture(listing.expires_at, now)) return build(AVAILABILITY.LISTING_ENDED)

  // checkout_orders sets status='reserved' when it drains the offered quantity,
  // so 'reserved' is the specific "a pending order holds it" case and a plain
  // zero quantity is the generic depleted case.
  if (listing.status === 'reserved') return build(AVAILABILITY.RESERVED)
  if (listing.status !== 'active') return build(AVAILABILITY.LISTING_ENDED)
  if (!(Number(listing.quantity) > 0)) return build(AVAILABILITY.SOLD_OUT)

  if (!isSignedIn) return build(AVAILABILITY.SIGNED_OUT)

  return build(AVAILABILITY.PURCHASABLE)
}
