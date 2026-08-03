// Deterministic, data-only fixture descriptors for the disposable local
// Phase 45C Auction overlap gate. SQL and participant behavior deliberately
// live in the tracked runner; a fixture cannot replace a named operation.

const ACTORS = Object.freeze({
  seller: 'b1000000-0000-4000-8000-000000900001',
  buyer1: 'b1000000-0000-4000-8000-000000900002',
  buyer2: 'b1000000-0000-4000-8000-000000900003',
  buyer3: 'b1000000-0000-4000-8000-000000900004',
})

const id = number => `b1000000-0000-4000-8001-${String(number).padStart(12, '0')}`

function descriptor(caseKey, ordinal, options = {}) {
  const base = ordinal * 1000
  const auctionCount = options.auctionCount || 1
  const cardCount = options.cardCount || auctionCount
  return Object.freeze({
    caseKey,
    ordinal,
    actors: ACTORS,
    auctionIds: Object.freeze(Array.from({ length: auctionCount }, (_, index) => id(base + 10 + index))),
    auctionItemIds: Object.freeze(Array.from({ length: Math.max(auctionCount, cardCount) * 2 }, (_, index) => id(base + 100 + index))),
    bidIds: Object.freeze(Array.from({ length: auctionCount }, (_, index) => id(base + 200 + index))),
    cardIds: Object.freeze(Array.from({ length: cardCount }, (_, index) => id(base + 300 + index))),
    catalogIds: Object.freeze(Array.from({ length: cardCount }, (_, index) => id(base + 400 + index))),
    checkoutKeys: Object.freeze([id(base + 500), id(base + 501)]),
    orderId: id(base + 600),
    listingId: id(base + 700),
    pickupIds: Object.freeze([id(base + 800), id(base + 801)]),
    initialState: options.initialState || 'active',
    secondState: options.secondState || options.initialState || 'active',
    initialBid: options.initialBid || null,
    cardQuantity: options.cardQuantity || 2,
    reverseSharedLots: options.reverseSharedLots === true,
    hasListing: options.hasListing === true,
    hasOrderLifecycle: options.hasOrderLifecycle === true,
  })
}

export function buildAuctionConcurrencyFixtures({ localOnly, dbContainer }) {
  if (localOnly !== true || !/^supabase_db_[a-zA-Z0-9_.-]+$/.test(dbContainer || '')) {
    throw new Error('Auction concurrency fixtures are restricted to a named local Supabase database container')
  }
  return Object.freeze({
    equalBid: descriptor('equalBid', 1),
    bidBuyout: descriptor('bidBuyout', 2),
    competingBuyouts: descriptor('competingBuyouts', 3),
    buyoutReplay: descriptor('buyoutReplay', 4),
    buyoutChangedPayload: descriptor('buyoutChangedPayload', 5, { auctionCount: 2 }),
    claimReplay: descriptor('claimReplay', 6, { initialState: 'ended_pending_winner', initialBid: 20 }),
    claimChangedPayload: descriptor('claimChangedPayload', 7, {
      auctionCount: 2,
      initialState: 'ended_pending_winner',
      secondState: 'ended_pending_winner',
      initialBid: 20,
    }),
    expiryNoBid: descriptor('expiryNoBid', 8),
    expiryWithBid: descriptor('expiryWithBid', 9, { initialBid: 20 }),
    claimDemotion: descriptor('claimDemotion', 10, { initialState: 'ended_pending_winner', initialBid: 20 }),
    publishDelete: descriptor('publishDelete', 11, { initialState: 'draft' }),
    publishEdit: descriptor('publishEdit', 12, { initialState: 'draft' }),
    reversePublish: descriptor('reversePublish', 13, {
      auctionCount: 2,
      cardCount: 2,
      initialState: 'draft',
      secondState: 'draft',
      reverseSharedLots: true,
      cardQuantity: 2,
    }),
    crossMarket: descriptor('crossMarket', 14, { initialState: 'draft', cardQuantity: 1, hasListing: true }),
    relistLifecycle: descriptor('relistLifecycle', 15, {
      initialState: 'ended_sold',
      initialBid: 20,
      hasOrderLifecycle: true,
    }),
    extendBidBuyout: descriptor('extendBidBuyout', 16),
  })
}
