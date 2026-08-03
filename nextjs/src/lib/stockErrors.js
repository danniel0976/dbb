// Keep database lifecycle details inside the server boundary. These codes are
// stable API contract values; database messages are logged, never returned.
export function stockError(error, fallback = 'STOCK_OPERATION_FAILED') {
  const message = String(error?.message || '')
  const mappings = [
    ['LISTING_CARD_OWNER_MISMATCH', 'LISTING_OWNERSHIP_CONFLICT', 409],
    ['RESERVATION_DRIFT', 'STOCK_STATE_CONFLICT', 409],
    ['LISTING_UNAVAILABLE', 'LISTING_UNAVAILABLE', 409],
    ['Listing is reserved by an active order', 'LISTING_RESERVED_BY_ORDER', 409],
    ['CLAIM_SALE_NOT_ACTIVE', 'CLAIM_SALE_NOT_ACTIVE', 409],
    ['CLAIM_SALE_ENDED', 'CLAIM_SALE_ENDED', 409],
    ['LISTING_CONFLICT', 'LISTING_CONFLICT', 409],
    ['23505', 'LISTING_CONFLICT', 409],
  ]
  const hit = mappings.find(([needle]) => message.includes(needle))
  return hit
    ? { error: hit[1], code: hit[1], status: hit[2] }
    : { error: fallback, code: fallback, status: 500 }
}
