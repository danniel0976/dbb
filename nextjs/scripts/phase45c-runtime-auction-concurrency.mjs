#!/usr/bin/env node

// Disposable-local forced-overlap gate for the 16 release-blocking Auction
// races. The fixture module is data-only. This file owns every setup shape,
// holder preparation, participant operation, accepted result, and invariant.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { buildAuctionConcurrencyFixtures } from './phase45c-auction-concurrency-fixtures.mjs'

const SOURCE_PATH = new URL(import.meta.url).pathname
const FIXTURE_PATH = new URL('./phase45c-auction-concurrency-fixtures.mjs', import.meta.url).pathname
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')
const FIXTURE_SOURCE = readFileSync(FIXTURE_PATH, 'utf8')
const DB_CONTAINER = process.env.PHASE45C_DB_CONTAINER || 'supabase_db_dbb-uat'
const STATIC_ONLY = process.argv.includes('--static-only')
const BARRIER_TOKEN = 'BARRIER_ACQUIRED'
const HOLD_TIMEOUT_MS = 60_000
const SETTLE_TIMEOUT_MS = 20_000
const PREFIX = 'phase45c-concurrency-'

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function uuid(value) {
  return `${sqlString(value)}::uuid`
}

function spawnPsql(sql, { keepOpen = false } = {}) {
  const child = spawn('docker', [
    'exec', '-i', DB_CONTAINER, 'psql', '-q', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', code => resolve({ code, stdout, stderr }))
  })
  if (keepOpen) child.stdin.write(sql)
  else child.stdin.end(sql)
  return { child, done, stdout: () => stdout, stderr: () => stderr }
}

async function mustPass(handle, label) {
  const result = await handle.done
  expect(result.code === 0, `${label} failed (psql ${result.code}): ${result.stderr || result.stdout}`)
  return result
}

function cleanupSql(fixture) {
  const actorIds = Object.values(fixture.actors).map(uuid).join(',')
  const pickupIds = fixture.pickupIds.map(uuid).join(',')
  return `BEGIN;
DELETE FROM public.marketplace_card_reservations WHERE owner_id IN (${actorIds});
DELETE FROM public.checkout_requests WHERE buyer_id IN (${actorIds});
DELETE FROM public.orders WHERE buyer_id IN (${actorIds}) OR seller_id IN (${actorIds});
DELETE FROM public.listings WHERE user_id IN (${actorIds});
UPDATE public.auctions SET current_bid_id=NULL WHERE seller_id=${uuid(fixture.actors.seller)};
DELETE FROM public.auctions WHERE seller_id=${uuid(fixture.actors.seller)};
DELETE FROM public.card_photos WHERE user_id=${uuid(fixture.actors.seller)};
DELETE FROM public.library_cards WHERE user_id=${uuid(fixture.actors.seller)};
DELETE FROM public.card_index WHERE scryfall_id IN (${fixture.catalogIds.map(uuid).join(',')});
DELETE FROM public.pickup_locations WHERE id IN (${pickupIds});
DELETE FROM auth.users WHERE id IN (${actorIds});
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN (${actorIds}))
    OR EXISTS (SELECT 1 FROM public.auctions WHERE seller_id=${uuid(fixture.actors.seller)})
    OR EXISTS (SELECT 1 FROM public.library_cards WHERE user_id=${uuid(fixture.actors.seller)})
    OR EXISTS (SELECT 1 FROM public.listings WHERE user_id=${uuid(fixture.actors.seller)})
    OR EXISTS (SELECT 1 FROM public.orders WHERE buyer_id IN (${actorIds}) OR seller_id IN (${actorIds}))
    OR EXISTS (SELECT 1 FROM public.checkout_requests WHERE buyer_id IN (${actorIds}))
    OR EXISTS (SELECT 1 FROM public.marketplace_card_reservations WHERE owner_id IN (${actorIds}))
  THEN RAISE EXCEPTION 'PHASE45C_FIXTURE_CLEANUP_INCOMPLETE'; END IF;
END $$;
COMMIT;`
}

function auctionState(fixture, index) {
  return index === 0 ? fixture.initialState : fixture.secondState
}

function buildSetupSql(fixture) {
  const { seller, buyer1, buyer2, buyer3 } = fixture.actors
  const cardRows = fixture.cardIds.map((cardId, index) => {
    const catalogId = fixture.catalogIds[index]
    return `INSERT INTO public.card_index(scryfall_id,name,set_code,set_name,collector_number)
VALUES (${uuid(catalogId)},${sqlString(`Concurrency Card ${fixture.ordinal}-${index + 1}`)},'TST','Concurrency Test',${sqlString(String(index + 1))});
INSERT INTO public.library_cards(id,user_id,binder_id,scryfall_id,quantity,foil,condition,language)
VALUES (${uuid(cardId)},${uuid(seller)},(SELECT id FROM public.binders WHERE user_id=${uuid(seller)} ORDER BY id LIMIT 1),${uuid(catalogId)},${fixture.cardQuantity},'normal','NM','en');
INSERT INTO public.card_photos(user_id,library_card_id,storage_path)
VALUES (${uuid(seller)},${uuid(cardId)},${sqlString(`${seller}/${cardId}/${catalogId}.jpg`)});`
  }).join('\n')

  const auctionRows = []
  let itemCursor = 0
  fixture.auctionIds.forEach((auctionId, auctionIndex) => {
    const state = auctionState(fixture, auctionIndex)
    const bidAmount = fixture.initialBid
    const bidId = fixture.bidIds[auctionIndex]
    const isDraft = state === 'draft'
    const isActive = state === 'active'
    const isPending = state === 'ended_pending_winner'
    const isSold = state === 'ended_sold'
    const currentBid = bidAmount === null ? 'NULL' : String(bidAmount)
    const currentBidId = bidAmount === null ? 'NULL' : uuid(bidId)
    const winnerId = isPending || isSold ? uuid(buyer1) : 'NULL'
    const settled = isSold && fixture.hasOrderLifecycle ? `ARRAY[${uuid(fixture.orderId)}]` : 'NULL'
    auctionRows.push(`INSERT INTO public.auctions(
  id,seller_id,title,status,starting_bid_myr,buyout_myr,bid_increment,duration_hours,
  published_at,expires_at,original_expires_at,soft_close_enabled,current_bid_myr,
  current_bid_id,bid_count,winner_id,won_at,settled_order_ids,settled_at)
VALUES (${uuid(auctionId)},${uuid(seller)},${sqlString(`${PREFIX}${fixture.caseKey}-${auctionIndex + 1}`)},${sqlString(state)},10,50,'any',1,
  ${isDraft ? 'NULL' : 'now()'},${isActive ? "now()+interval '1 hour'" : 'NULL'},${isActive ? "now()+interval '1 hour'" : 'NULL'},true,${currentBid},
  ${currentBidId},${bidAmount === null ? 0 : 1},${winnerId},${isPending || isSold ? 'now()' : 'NULL'},${settled},${isSold ? 'now()' : 'NULL'});`)

    const lotCards = fixture.reverseSharedLots
      ? (auctionIndex === 0 ? fixture.cardIds : [...fixture.cardIds].reverse())
      : [fixture.cardIds[Math.min(auctionIndex, fixture.cardIds.length - 1)]]
    lotCards.forEach(cardId => {
      const cardIndex = fixture.cardIds.indexOf(cardId)
      const itemId = fixture.auctionItemIds[itemCursor++]
      auctionRows.push(`INSERT INTO public.auction_items(
  id,auction_id,library_card_id,quantity,scryfall_id,card_name,set_code,set_name,collector_number,finish,condition,language)
VALUES (${uuid(itemId)},${uuid(auctionId)},${uuid(cardId)},1,${sqlString(fixture.catalogIds[cardIndex])},
  ${sqlString(`Concurrency Card ${fixture.ordinal}-${cardIndex + 1}`)},'TST','Concurrency Test',${sqlString(String(cardIndex + 1))},'normal','NM','en');`)
    })
    if (bidAmount !== null) {
      auctionRows.push(`INSERT INTO public.auction_bids(id,auction_id,bidder_id,amount_myr)
VALUES (${uuid(bidId)},${uuid(auctionId)},${uuid(buyer1)},${bidAmount});`)
    }
    if (isActive || isPending) {
      lotCards.forEach(cardId => {
        auctionRows.push(`INSERT INTO public.marketplace_card_reservations(library_card_id,owner_id,source_kind,source_id,reserved_quantity)
VALUES (${uuid(cardId)},${uuid(seller)},'auction',${uuid(auctionId)},1);`)
      })
    }
  })

  const listingRow = fixture.hasListing ? `INSERT INTO public.listings(id,user_id,library_card_id,multiplier,status,expires_at,quantity)
VALUES (${uuid(fixture.listingId)},${uuid(seller)},${uuid(fixture.cardIds[0])},2.5,'expired',now()+interval '1 hour',1);` : ''

  const lifecycleRows = fixture.hasOrderLifecycle ? `INSERT INTO public.orders(id,buyer_id,seller_id,pickup_location_id,status,total_myr)
VALUES (${uuid(fixture.orderId)},${uuid(buyer1)},${uuid(seller)},${uuid(fixture.pickupIds[0])},'awaiting_payment',20);
INSERT INTO public.order_items(order_id,library_card_id,quantity,unit_myr,line_myr,multiplier,scryfall_id,card_name,price_source,auction_id,auction_item_id,finish,condition)
VALUES (${uuid(fixture.orderId)},${uuid(fixture.cardIds[0])},1,20,20,NULL,${uuid(fixture.catalogIds[0])},
  ${sqlString(`Concurrency Card ${fixture.ordinal}-1`)},'auction_bid',${uuid(fixture.auctionIds[0])},${uuid(fixture.auctionItemIds[0])},'normal','NM');
INSERT INTO public.marketplace_card_reservations(library_card_id,owner_id,source_kind,source_id,reserved_quantity)
VALUES (${uuid(fixture.cardIds[0])},${uuid(seller)},'order',${uuid(fixture.orderId)},1);` : ''

  return `BEGIN;
INSERT INTO public.pickup_locations(id,slug,name,address,active,is_default) VALUES
  (${uuid(fixture.pickupIds[0])},${sqlString(`${PREFIX}${fixture.ordinal}-pickup-a`)},'Concurrency Pickup A','Local fixture',true,false),
  (${uuid(fixture.pickupIds[1])},${sqlString(`${PREFIX}${fixture.ordinal}-pickup-b`)},'Concurrency Pickup B','Local fixture',true,false);
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
  (${uuid(seller)},${sqlString(`${PREFIX}seller@example.test`)},'{"username":"p45c_seller"}'),
  (${uuid(buyer1)},${sqlString(`${PREFIX}buyer1@example.test`)},'{"username":"p45c_buyer1"}'),
  (${uuid(buyer2)},${sqlString(`${PREFIX}buyer2@example.test`)},'{"username":"p45c_buyer2"}'),
  (${uuid(buyer3)},${sqlString(`${PREFIX}buyer3@example.test`)},'{"username":"p45c_buyer3"}');
UPDATE public.profiles SET merchant_profile_completed_at=now(),merchant_bank_name='Local Test Bank',
  merchant_account_name='Local Seller',merchant_account_number='00000001' WHERE id=${uuid(seller)};
${cardRows}
${auctionRows.join('\n')}
${listingRow}
${lifecycleRows}
DO $$ BEGIN
  IF (SELECT count(*) FROM public.auctions WHERE id IN (${fixture.auctionIds.map(uuid).join(',')})) <> ${fixture.auctionIds.length}
    OR (SELECT count(*) FROM public.library_cards WHERE id IN (${fixture.cardIds.map(uuid).join(',')})) <> ${fixture.cardIds.length}
    OR (SELECT count(*) FROM public.profiles WHERE id IN (${Object.values(fixture.actors).map(uuid).join(',')})) <> 4
  THEN RAISE EXCEPTION 'PHASE45C_FIXTURE_ADMISSION_FAILED_${fixture.caseKey}'; END IF;
END $$;
COMMIT;`
}

function renderHolderPreparation(caseKey, fixture) {
  switch (caseKey) {
    case 'expiryNoBid':
    case 'expiryWithBid':
      return `UPDATE public.auctions SET expires_at=now()-interval '1 minute' WHERE id=${uuid(fixture.auctionIds[0])};`
    case 'claimDemotion':
      return `UPDATE public.auctions SET won_at=now()-interval '25 hours' WHERE id=${uuid(fixture.auctionIds[0])};`
    case 'extendBidBuyout':
      return `UPDATE public.auctions SET expires_at=now()+interval '1 minute' WHERE id=${uuid(fixture.auctionIds[0])};`
    default:
      return ''
  }
}

// BARRIER-SCRIPT-BEGIN
function holdAuctionLocks(caseKey, fixture) {
  const auctions = [...new Set(fixture.auctionIds)].sort()
  const cards = [...new Set(fixture.cardIds)].sort()
  expect(auctions.length > 0, `${caseKey}: holder requires at least one auction`)
  const holder = spawnPsql(`BEGIN;
SELECT pg_backend_pid() AS barrier_pid
\\gset
\\echo BARRIER_PID :barrier_pid
SELECT id FROM public.auctions WHERE id = ANY(ARRAY[${auctions.map(uuid).join(',')}]) ORDER BY id FOR UPDATE;
SELECT id FROM public.library_cards WHERE id = ANY(ARRAY[${cards.map(uuid).join(',')}]) ORDER BY id FOR UPDATE;
${renderHolderPreparation(caseKey, fixture)}
\\echo BARRIER_ACQUIRED
`, { keepOpen: true })
  let holderPid = null
  let seenBarrier = false
  let pending = ''
  let resolveAcquired
  let rejectAcquired
  const acquired = new Promise((resolve, reject) => {
    resolveAcquired = resolve
    rejectAcquired = reject
  })
  holder.child.stdout.on('data', chunk => {
    pending += chunk.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() || ''
    for (const line of lines) {
      const pid = /^BARRIER_PID\s+(\d+)$/.exec(line.trim())
      if (pid) holderPid = Number(pid[1])
      if (line.trim() === BARRIER_TOKEN && !seenBarrier) {
        seenBarrier = true
        resolveAcquired()
      }
    }
  })
  holder.child.on('exit', code => {
    if (!seenBarrier) rejectAcquired(new Error(`${caseKey}: holder exited ${code} before isolated ${BARRIER_TOKEN}: ${holder.stderr()}`))
  })
  let released = false
  let autoReleased = false
  let watchdog
  function release() {
    if (released) return
    released = true
    clearTimeout(watchdog)
    holder.child.stdin.end('COMMIT;\n')
  }
  watchdog = setTimeout(() => {
    autoReleased = true
    release()
  }, HOLD_TIMEOUT_MS)
  return {
    acquired,
    release,
    done: holder.done,
    holderPid: () => holderPid,
    autoReleased: () => autoReleased,
  }
}
// BARRIER-SCRIPT-END

async function observeHeldResourceWaiter(caseKey, holderPid, fixture) {
  expect(Number.isInteger(holderPid), `${caseKey}: holder did not expose its backend PID`)
  const auctionIds = fixture.auctionIds.map(uuid).join(',')
  const cardIds = fixture.cardIds.map(uuid).join(',')
  const queryPatterns = [...fixture.auctionIds, ...fixture.cardIds].map(value => sqlString(`%${value}%`)).join(',')
  const probe = spawnPsql(`DO $$
DECLARE
  v_waiters integer := 0;
  v_auction_locks integer := 0;
  v_card_locks integer := 0;
  v_i integer;
BEGIN
  FOR v_i IN 1..200 LOOP
    SELECT count(DISTINCT a.id) INTO v_auction_locks
    FROM pgrowlocks('public.auctions') r
    JOIN public.auctions a ON a.ctid=r.locked_row
    WHERE a.id=ANY(ARRAY[${auctionIds}]) AND ${holderPid}=ANY(r.pids);
    SELECT count(DISTINCT c.id) INTO v_card_locks
    FROM pgrowlocks('public.library_cards') r
    JOIN public.library_cards c ON c.ctid=r.locked_row
    WHERE c.id=ANY(ARRAY[${cardIds}]) AND ${holderPid}=ANY(r.pids);
    SELECT count(DISTINCT a.pid) INTO v_waiters
    FROM pg_stat_activity a
    WHERE a.application_name LIKE ${sqlString(`phase45c:${caseKey}:%`)}
      AND a.wait_event_type='Lock'
      AND ${holderPid}=ANY(pg_blocking_pids(a.pid))
      AND a.query ILIKE ANY(ARRAY[${queryPatterns}])
      AND EXISTS (
        SELECT 1 FROM pg_locks waiting
        WHERE waiting.pid=a.pid AND NOT waiting.granted
          AND waiting.locktype IN ('transactionid','tuple')
      );
    EXIT WHEN v_waiters > 0
      AND v_auction_locks = ${fixture.auctionIds.length}
      AND v_card_locks = ${fixture.cardIds.length};
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE NOTICE 'ROW_SCOPED_WAIT=%,AUCTION_ROWS=%,CARD_ROWS=%',v_waiters,v_auction_locks,v_card_locks;
  IF v_waiters < 1 OR v_auction_locks <> ${fixture.auctionIds.length} OR v_card_locks <> ${fixture.cardIds.length} THEN
    RAISE EXCEPTION 'ROW_SCOPED_CONTENTION_NOT_PROVEN';
  END IF;
END $$;`)
  const result = await mustPass(probe, `${caseKey}: held-row contention proof`)
  const evidence = /ROW_SCOPED_WAIT=(\d+),AUCTION_ROWS=(\d+),CARD_ROWS=(\d+)/.exec(result.stderr)
  expect(evidence, `${caseKey}: row-scoped contention evidence was not emitted`)
  return { waiters: Number(evidence[1]), auctionRows: Number(evidence[2]), cardRows: Number(evidence[3]) }
}

const participant = (name, operation, accepts) => Object.freeze({ name, operation, accepts: Object.freeze(accepts) })

const MATRIX = Object.freeze({
  equalBid: Object.freeze({ participants: Object.freeze([
    participant('bidder-one', 'bid1At20', ['ok', 'BID_TOO_LOW']),
    participant('bidder-two', 'bid2At20', ['ok', 'BID_TOO_LOW']),
  ]) }),
  bidBuyout: Object.freeze({ participants: Object.freeze([
    participant('bid', 'bid1At20', ['ok', 'AUCTION_ENDED']),
    participant('buyout', 'buyout2Key2Auction1', ['ok']),
  ]) }),
  competingBuyouts: Object.freeze({ participants: Object.freeze([
    participant('buyer-one', 'buyout1Key1Auction1', ['ok', 'AUCTION_ENDED']),
    participant('buyer-two', 'buyout2Key2Auction1', ['ok', 'AUCTION_ENDED']),
  ]) }),
  buyoutReplay: Object.freeze({ participants: Object.freeze([
    participant('first', 'buyout1Key1Auction1', ['ok']),
    participant('replay', 'buyout1Key1Auction1', ['ok']),
  ]) }),
  buyoutChangedPayload: Object.freeze({ participants: Object.freeze([
    participant('original', 'buyout1Key1Auction1', ['ok', 'IDEMPOTENCY_KEY_REUSED']),
    participant('changed', 'buyout1Key1Auction2Pickup2', ['ok', 'IDEMPOTENCY_KEY_REUSED']),
  ]) }),
  claimReplay: Object.freeze({ participants: Object.freeze([
    participant('first', 'claim1Key1Auction1', ['ok']),
    participant('replay', 'claim1Key1Auction1', ['ok']),
  ]) }),
  claimChangedPayload: Object.freeze({ participants: Object.freeze([
    participant('original', 'claim1Key1Auction1', ['ok', 'IDEMPOTENCY_KEY_REUSED']),
    participant('changed', 'claim1Key1Auction2Pickup2', ['ok', 'IDEMPOTENCY_KEY_REUSED']),
  ]) }),
  expiryNoBid: Object.freeze({ participants: Object.freeze([
    participant('late-bid', 'bid1At20', ['ok']),
    participant('expiry', 'settleExpired', ['ok']),
  ]) }),
  expiryWithBid: Object.freeze({ participants: Object.freeze([
    participant('late-bid', 'bid2At30', ['ok']),
    participant('expiry', 'settleExpired', ['ok']),
  ]) }),
  claimDemotion: Object.freeze({ participants: Object.freeze([
    participant('winner-claim', 'claim1Key1Auction1', ['ok']),
    participant('demotion', 'settleExpired', ['ok']),
  ]) }),
  publishDelete: Object.freeze({ participants: Object.freeze([
    participant('publish', 'publishAuction1', ['ok', 'AUCTION_NOT_FOUND']),
    participant('draft-delete', 'deleteDraftAuction1', ['ok']),
  ]) }),
  publishEdit: Object.freeze({ participants: Object.freeze([
    participant('publish', 'publishAuction1', ['ok']),
    participant('draft-edit', 'editDraftAuction1', ['ok', 'AUCTION_NOT_DRAFT']),
  ]) }),
  reversePublish: Object.freeze({ participants: Object.freeze([
    participant('forward-lot', 'publishAuction1', ['ok']),
    participant('reverse-lot', 'publishAuction2', ['ok']),
  ]) }),
  crossMarket: Object.freeze({ participants: Object.freeze([
    participant('auction-publish', 'publishAuction1', ['ok', 'LOT_UNAVAILABLE']),
    participant('listing-activate', 'activateListing', ['ok', 'RESERVATION_DRIFT']),
  ]) }),
  relistLifecycle: Object.freeze({ participants: Object.freeze([
    participant('relist', 'relistAuction1', ['ok', 'AUCTION_NOT_RELISTABLE']),
    participant('order-cancel', 'cancelOrder', ['ok']),
  ]) }),
  extendBidBuyout: Object.freeze({ participants: Object.freeze([
    participant('extension', 'extendAuction1', ['ok', 'AUCTION_ENDED']),
    participant('bid', 'bid1At20', ['ok', 'AUCTION_ENDED']),
    participant('buyout', 'buyout2Key2Auction1', ['ok']),
  ]) }),
})

const KNOWN_OPERATIONS = Object.freeze([
  'bid1At20', 'bid2At20', 'bid2At30', 'buyout1Key1Auction1',
  'buyout1Key1Auction2Pickup2', 'buyout2Key2Auction1', 'claim1Key1Auction1',
  'claim1Key1Auction2Pickup2', 'settleExpired', 'publishAuction1',
  'publishAuction2', 'deleteDraftAuction1', 'editDraftAuction1', 'activateListing',
  'relistAuction1', 'cancelOrder', 'extendAuction1',
])

function renderOperation(operation, fixture) {
  const { seller, buyer1, buyer2 } = fixture.actors
  switch (operation) {
    case 'bid1At20': return `SELECT public.place_auction_bid(${uuid(fixture.auctionIds[0])},${uuid(buyer1)},20);`
    case 'bid2At20': return `SELECT public.place_auction_bid(${uuid(fixture.auctionIds[0])},${uuid(buyer2)},20);`
    case 'bid2At30': return `SELECT public.place_auction_bid(${uuid(fixture.auctionIds[0])},${uuid(buyer2)},30);`
    case 'buyout1Key1Auction1': return `SELECT public.checkout_auction_buyout(${uuid(buyer1)},${uuid(fixture.checkoutKeys[0])},${uuid(fixture.pickupIds[0])},${uuid(fixture.auctionIds[0])});`
    case 'buyout1Key1Auction2Pickup2': return `SELECT public.checkout_auction_buyout(${uuid(buyer1)},${uuid(fixture.checkoutKeys[0])},${uuid(fixture.pickupIds[1])},${uuid(fixture.auctionIds[1])});`
    case 'buyout2Key2Auction1': return `SELECT public.checkout_auction_buyout(${uuid(buyer2)},${uuid(fixture.checkoutKeys[1])},${uuid(fixture.pickupIds[0])},${uuid(fixture.auctionIds[0])});`
    case 'claim1Key1Auction1': return `SELECT public.checkout_auction_claim(${uuid(buyer1)},${uuid(fixture.checkoutKeys[0])},${uuid(fixture.pickupIds[0])},${uuid(fixture.auctionIds[0])});`
    case 'claim1Key1Auction2Pickup2': return `SELECT public.checkout_auction_claim(${uuid(buyer1)},${uuid(fixture.checkoutKeys[0])},${uuid(fixture.pickupIds[1])},${uuid(fixture.auctionIds[1])});`
    case 'settleExpired': return 'SELECT public.settle_expired_auctions(50,now());'
    case 'publishAuction1': return `SELECT public.publish_auction(${uuid(seller)},${uuid(fixture.auctionIds[0])});`
    case 'publishAuction2': return `SELECT public.publish_auction(${uuid(seller)},${uuid(fixture.auctionIds[1])});`
    case 'deleteDraftAuction1': return `DELETE FROM public.auctions WHERE id=${uuid(fixture.auctionIds[0])} AND status='draft';`
    case 'editDraftAuction1': return `SELECT public.update_auction_draft(${uuid(seller)},${uuid(fixture.auctionIds[0])},'edited title');`
    case 'activateListing': return `UPDATE public.listings SET status='active',expires_at=now()+interval '1 hour' WHERE id=${uuid(fixture.listingId)};`
    case 'relistAuction1': return `SELECT public.relist_auction(${uuid(seller)},${uuid(fixture.auctionIds[0])},3);`
    case 'cancelOrder': return `SELECT public.transition_order(${uuid(fixture.orderId)},${uuid(seller)},'cancel','local concurrency cancellation');`
    case 'extendAuction1': return `SELECT public.extend_auction(${uuid(fixture.auctionIds[0])},${uuid(seller)},15,${sqlString(fixture.checkoutKeys[0])});`
    default: throw new Error(`unknown closed Auction participant operation: ${operation}`)
  }
}

function startParticipant(caseKey, fixture, definition, index) {
  const applicationName = `phase45c:${caseKey}:${index + 1}:${definition.name}`
  const sql = `SET application_name=${sqlString(applicationName)};
SET statement_timeout='15s';
${renderOperation(definition.operation, fixture)}`
  return spawnPsql(sql).done.then(result => ({ ...result, definition }))
}

// BARRIER-OVERLAP-BEGIN
async function runHeldAuctionOverlap(caseKey, fixture, definition) {
  const holder = holdAuctionLocks(caseKey, fixture)
  let participants = []
  let settledBeforeRelease = 0
  let releasedAt = 0
  let evidence
  try {
    await holder.acquired
    participants = definition.participants.map((entry, index) => startParticipant(caseKey, fixture, entry, index))
    for (const promise of participants) promise.finally(() => { settledBeforeRelease += releasedAt === 0 ? 1 : 0 })
    evidence = await observeHeldResourceWaiter(caseKey, holder.holderPid(), fixture)
    expect(settledBeforeRelease < participants.length, `${caseKey}: every participant settled before explicit release`)
    releasedAt = Date.now()
    holder.release()
    const settlements = await Promise.race([
      Promise.allSettled(participants),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${caseKey}: participants did not settle after release`)), SETTLE_TIMEOUT_MS)),
    ])
    expect(settlements.every(result => result.status === 'fulfilled'), `${caseKey}: a participant process failed to report settlement`)
    return { results: settlements.map(result => result.value), evidence, releasedAt }
  } finally {
    holder.release()
    const holderResult = await holder.done
    await Promise.allSettled(participants)
    expect(holderResult.code === 0, `${caseKey}: holder failed: ${holderResult.stderr}`)
    expect(!holder.autoReleased(), `${caseKey}: holder watchdog released the transaction`)
  }
}
// BARRIER-OVERLAP-END

function classifyResult(result) {
  if (result.code === 0) return 'ok'
  return result.definition.accepts.find(value => value !== 'ok' && result.stderr.includes(value)) || 'unexpected-error'
}

function verifyParticipantOutcomes(caseKey, results) {
  for (const result of results) {
    const classification = classifyResult(result)
    expect(result.definition.accepts.includes(classification),
      `${caseKey}/${result.definition.name}: unexpected participant result ${result.code}: ${result.stderr || result.stdout}`)
    result.classification = classification
  }
  const okCount = results.filter(result => result.classification === 'ok').length
  switch (caseKey) {
    case 'equalBid':
      expect(okCount === 1 && results.some(result => result.classification === 'BID_TOO_LOW'), `${caseKey}: expected one accepted bid and one BID_TOO_LOW`)
      break
    case 'competingBuyouts':
      expect(okCount === 1 && results.some(result => result.classification === 'AUCTION_ENDED'), `${caseKey}: expected one buyout and one AUCTION_ENDED`)
      break
    case 'buyoutReplay':
    case 'claimReplay':
      expect(okCount === 2, `${caseKey}: both exact-key participants must succeed`)
      expect(results[0].stdout.trim() === results[1].stdout.trim(), `${caseKey}: exact replay responses differ`)
      expect(results[0].stdout.includes('CHECKOUT_COMPLETE'), `${caseKey}: replay did not return CHECKOUT_COMPLETE`)
      break
    case 'buyoutChangedPayload':
    case 'claimChangedPayload':
      expect(okCount === 1 && results.some(result => result.classification === 'IDEMPOTENCY_KEY_REUSED'), `${caseKey}: changed payload did not yield one exact IDEMPOTENCY_KEY_REUSED`)
      break
    case 'expiryNoBid':
    case 'expiryWithBid':
      expect(results.find(result => result.definition.name === 'late-bid')?.stdout.includes('AUCTION_ENDED'), `${caseKey}: late bidder did not observe AUCTION_ENDED`)
      break
    case 'claimDemotion':
      expect(results.find(result => result.definition.name === 'winner-claim')?.stdout.includes('CLAIM_WINDOW_EXPIRED'), `${caseKey}: stale winner did not observe CLAIM_WINDOW_EXPIRED`)
      break
    case 'reversePublish':
      expect(okCount === 2, `${caseKey}: both sorted multi-card publishes must succeed`)
      break
    case 'crossMarket':
      expect(okCount === 1, `${caseKey}: exactly one marketplace commitment must succeed`)
      break
    case 'extendBidBuyout':
      expect(results.find(result => result.definition.name === 'buyout')?.classification === 'ok', `${caseKey}: buyout must win terminal settlement`)
      break
    default:
      expect(okCount >= 1, `${caseKey}: no participant succeeded`)
  }
}

function caseInvariantSql(caseKey, fixture) {
  const a1 = uuid(fixture.auctionIds[0])
  const a2 = fixture.auctionIds[1] ? uuid(fixture.auctionIds[1]) : null
  const c1 = uuid(fixture.cardIds[0])
  const buyer1 = uuid(fixture.actors.buyer1)
  const key1 = uuid(fixture.checkoutKeys[0])
  let condition
  switch (caseKey) {
    case 'equalBid':
      condition = `EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='active' AND bid_count=1 AND current_bid_myr=20) AND (SELECT count(*) FROM public.auction_bids WHERE auction_id=${a1})=1`
      break
    case 'bidBuyout':
    case 'competingBuyouts':
    case 'extendBidBuyout':
      condition = `EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='ended_sold') AND (SELECT count(*) FROM public.order_items WHERE auction_id=${a1})=1 AND NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=${a1}) AND (SELECT count(*) FROM public.marketplace_card_reservations r JOIN public.order_items oi ON oi.order_id=r.source_id WHERE r.source_kind='order' AND oi.auction_id=${a1})=1`
      break
    case 'buyoutReplay':
    case 'claimReplay':
      condition = `EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='ended_sold') AND (SELECT count(*) FROM public.order_items WHERE auction_id=${a1})=1 AND (SELECT count(*) FROM public.checkout_requests WHERE buyer_id=${buyer1} AND idempotency_key=${key1} AND status='completed')=1`
      break
    case 'buyoutChangedPayload':
      condition = `(SELECT count(*) FROM public.auctions WHERE id IN (${a1},${a2}) AND status='ended_sold')=1 AND (SELECT count(*) FROM public.auctions WHERE id IN (${a1},${a2}) AND status='active')=1 AND (SELECT count(*) FROM public.order_items WHERE auction_id IN (${a1},${a2}))=1 AND (SELECT count(*) FROM public.checkout_requests WHERE buyer_id=${buyer1} AND idempotency_key=${key1})=1`
      break
    case 'claimChangedPayload':
      condition = `(SELECT count(*) FROM public.auctions WHERE id IN (${a1},${a2}) AND status='ended_sold')=1 AND (SELECT count(*) FROM public.auctions WHERE id IN (${a1},${a2}) AND status='ended_pending_winner')=1 AND (SELECT count(*) FROM public.order_items WHERE auction_id IN (${a1},${a2}))=1 AND (SELECT count(*) FROM public.checkout_requests WHERE buyer_id=${buyer1} AND idempotency_key=${key1})=1`
      break
    case 'expiryNoBid':
      condition = `EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='expired' AND bid_count=0) AND NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=${a1})`
      break
    case 'expiryWithBid':
      condition = `EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='ended_pending_winner' AND winner_id=${buyer1} AND bid_count=1 AND current_bid_myr=20) AND EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=${a1})`
      break
    case 'claimDemotion':
      condition = `EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='relist_available') AND NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=${a1}) AND EXISTS(SELECT 1 FROM public.checkout_requests WHERE buyer_id=${buyer1} AND idempotency_key=${key1} AND result_code='CLAIM_WINDOW_EXPIRED')`
      break
    case 'publishDelete':
      condition = `(NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1}) AND NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id=${a1})) OR (EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='active') AND (SELECT count(*) FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=${a1})=1)`
      break
    case 'publishEdit':
      condition = `EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='active' AND title IN (${sqlString(`${PREFIX}${fixture.caseKey}-1`)},'edited title')) AND (SELECT count(*) FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=${a1})=1`
      break
    case 'reversePublish':
      condition = `(SELECT count(*) FROM public.auctions WHERE id IN (${a1},${a2}) AND status='active')=2 AND (SELECT count(*) FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id IN (${a1},${a2}))=4 AND NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE library_card_id IN (${fixture.cardIds.map(uuid).join(',')}) GROUP BY library_card_id HAVING sum(reserved_quantity)<>2)`
      break
    case 'crossMarket':
      condition = `((EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='active'))::integer + (EXISTS(SELECT 1 FROM public.listings WHERE id=${uuid(fixture.listingId)} AND status='active'))::integer)=1 AND (SELECT coalesce(sum(reserved_quantity),0) FROM public.marketplace_card_reservations WHERE library_card_id=${c1})=1`
      break
    case 'relistLifecycle':
      condition = `EXISTS(SELECT 1 FROM public.orders WHERE id=${uuid(fixture.orderId)} AND status='cancelled') AND EXISTS(SELECT 1 FROM public.auctions WHERE id=${a1} AND status='relist_available') AND NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=${uuid(fixture.orderId)}) AND (SELECT count(*) FROM public.auctions WHERE relisted_from_auction_id=${a1} AND status='active') <= 1`
      break
    default:
      throw new Error(`missing per-case invariant for ${caseKey}`)
  }
  return `DO $$ BEGIN IF NOT (${condition}) THEN RAISE EXCEPTION 'PHASE45C_CASE_INVARIANT_${caseKey}'; END IF; END $$;`
}

const GLOBAL_INVARIANT_SQL = `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.auctions a
    LEFT JOIN LATERAL (SELECT count(*)::integer AS n,max(amount_myr) AS top FROM public.auction_bids b WHERE b.auction_id=a.id) b ON true
    WHERE a.bid_count<>b.n OR (b.n>0 AND (a.current_bid_myr<>b.top OR a.current_bid_id IS NULL))
  ) THEN RAISE EXCEPTION 'AUCTION_BID_LEDGER_INCONSISTENT'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.marketplace_card_reservations r JOIN public.library_cards c ON c.id=r.library_card_id
    GROUP BY r.library_card_id,c.quantity HAVING sum(r.reserved_quantity)>c.quantity
  ) THEN RAISE EXCEPTION 'GLOBAL_RESERVATION_EXCEEDS_INVENTORY'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.marketplace_card_reservations r LEFT JOIN public.auctions a ON a.id=r.source_id
    WHERE r.source_kind='auction' AND (a.id IS NULL OR a.status NOT IN ('active','ended_pending_winner'))
  ) THEN RAISE EXCEPTION 'STALE_AUCTION_RESERVATION'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.marketplace_card_reservations r
    LEFT JOIN public.auction_items ai ON ai.auction_id=r.source_id AND ai.library_card_id=r.library_card_id
    WHERE r.source_kind='auction' AND (ai.id IS NULL OR ai.quantity<>r.reserved_quantity)
  ) THEN RAISE EXCEPTION 'AUCTION_RESERVATION_SNAPSHOT_MISMATCH'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.marketplace_card_reservations r JOIN public.orders o ON o.id=r.source_id
    WHERE r.source_kind='order' AND o.status IN ('cancelled','order_completed')
  ) THEN RAISE EXCEPTION 'STALE_TERMINAL_ORDER_RESERVATION'; END IF;
  IF EXISTS (SELECT 1 FROM public.checkout_requests WHERE status='processing')
  THEN RAISE EXCEPTION 'ORPHAN_CHECKOUT_REQUEST'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_items oi LEFT JOIN public.auctions a ON a.id=oi.auction_id
    WHERE oi.auction_id IS NOT NULL AND a.id IS NULL
  ) THEN RAISE EXCEPTION 'ORPHAN_AUCTION_ORDER_ITEM'; END IF;
END $$;`

async function assertCaseInvariant(caseKey, fixture) {
  await mustPass(spawnPsql(caseInvariantSql(caseKey, fixture)), `${caseKey}: per-case invariant`)
}

async function assertGlobalInvariants(caseKey) {
  await mustPass(spawnPsql(GLOBAL_INVARIANT_SQL), `${caseKey}: global invariants`)
}

async function verifyCleanup(caseKey, fixture) {
  await mustPass(spawnPsql(cleanupSql(fixture)), `${caseKey}: cleanup verification`)
}

async function removeLocalPgrowlocksExtension(wasPresent) {
  if (wasPresent) return
  await mustPass(spawnPsql(`DROP EXTENSION pgrowlocks;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pgrowlocks')
THEN RAISE EXCEPTION 'PGROWLOCKS_CLEANUP_INCOMPLETE'; END IF; END $$;`), 'pgrowlocks cleanup verification')
}

// STATIC-CONTRACT-BEGIN
function executionRegion(source) {
  const start = source.indexOf('// STATIC-CONTRACT-BEGIN')
  const end = source.lastIndexOf('// STATIC-CONTRACT-END')
  return start < 0 || end < start ? source : `${source.slice(0, start)}${source.slice(end)}`
}

function staticViolations(runtimeSource, fixtureSource) {
  const problems = []
  const execution = executionRegion(runtimeSource)
  const barrier = execution.slice(execution.indexOf('// BARRIER-SCRIPT-BEGIN'), execution.indexOf('// BARRIER-SCRIPT-END'))
  const overlap = execution.slice(execution.indexOf('// BARRIER-OVERLAP-BEGIN'), execution.indexOf('// BARRIER-OVERLAP-END'))
  if (!execution.includes("from './phase45c-auction-concurrency-fixtures.mjs'")) problems.push('tracked-fixture-builder-missing')
  if (/process\.env|participantSql|operationSql|withinTransactionSql|invariantSql|setupSql/.test(fixtureSource)) problems.push('fixture-is-not-data-only')
  if (/fixture\.(participantSql|operationSql|withinTransactionSql|invariantSql|setupSql)/.test(execution)) problems.push('fixture-can-inject-executable-sql')
  if (!execution.includes('const MATRIX = Object.freeze({') || !execution.includes('participants: Object.freeze([')) problems.push('executable-participant-contracts-missing')
  if (!execution.includes('renderOperation(definition.operation, fixture)')) problems.push('closed-operation-registry-bypassed')
  if (!barrier.includes('ORDER BY id FOR UPDATE')) problems.push('holder-locks-not-sorted')
  const auctionLock = barrier.indexOf('FROM public.auctions')
  const cardLock = barrier.indexOf('FROM public.library_cards')
  const sentinel = barrier.indexOf('\\\\echo BARRIER_ACQUIRED\n')
  if (auctionLock < 0 || cardLock < auctionLock) problems.push('holder-does-not-lock-auction-then-cards')
  if (sentinel < cardLock) problems.push('isolated-sentinel-not-after-row-locks')
  if (!barrier.includes('renderHolderPreparation(caseKey, fixture)')) problems.push('closed-holder-preparation-missing')
  if (!overlap.includes('await holder.acquired')) problems.push('sentinel-not-awaited')
  if (!overlap.includes('await observeHeldResourceWaiter(')) problems.push('contention-proof-not-awaited')
  if (!overlap.includes('releasedAt = Date.now()\n    holder.release()')) problems.push('explicit-release-missing')
  if (!overlap.includes('const settlements = await Promise.race([\n      Promise.allSettled(participants)')) problems.push('post-release-settlement-missing')
  if (!execution.includes("pgrowlocks('public.auctions')") || !execution.includes("pgrowlocks('public.library_cards')") || !execution.includes('a.ctid=r.locked_row')) problems.push('held-row-lock-proof-missing')
  if (!execution.includes('pg_blocking_pids(a.pid)') || !execution.includes('a.query ILIKE ANY') || !execution.includes('application_name LIKE')) problems.push('waiter-not-correlated-to-held-resource-query')
  if (!execution.includes('await assertCaseInvariant(caseKey, fixture)')) problems.push('per-case-invariants-not-executed')
  if (!execution.includes('await assertGlobalInvariants(caseKey)')) problems.push('global-invariants-not-executed')
  if (!execution.includes('await verifyCleanup(caseKey, fixture)')) problems.push('cleanup-verification-not-executed')
  if (!execution.includes('await removeLocalPgrowlocksExtension(extensionWasPresent)')) problems.push('inspection-extension-cleanup-not-executed')
  return problems
}

function validateMatrixAndFixtures(fixtures) {
  const matrixKeys = Object.keys(MATRIX)
  const fixtureKeys = Object.keys(fixtures)
  expect(matrixKeys.length === 16, `expected 16 named matrix contracts, found ${matrixKeys.length}`)
  expect(JSON.stringify(matrixKeys) === JSON.stringify(fixtureKeys), 'matrix and fixture case order/names differ')
  const allowedFixtureKeys = new Set([
    'caseKey', 'ordinal', 'actors', 'auctionIds', 'auctionItemIds', 'bidIds', 'cardIds',
    'catalogIds', 'checkoutKeys', 'orderId', 'listingId', 'pickupIds', 'initialState',
    'secondState', 'initialBid', 'cardQuantity', 'reverseSharedLots', 'hasListing', 'hasOrderLifecycle',
  ])
  for (const caseKey of matrixKeys) {
    const fixture = fixtures[caseKey]
    const definition = MATRIX[caseKey]
    expect(fixture.caseKey === caseKey, `${caseKey}: fixture identity mismatch`)
    expect(definition.participants.length >= 2, `${caseKey}: needs at least two executable participants`)
    for (const entry of definition.participants) {
      expect(KNOWN_OPERATIONS.includes(entry.operation), `${caseKey}: unknown operation ${entry.operation}`)
      expect(entry.accepts.length > 0, `${caseKey}/${entry.name}: accepted outcomes missing`)
    }
    for (const key of Object.keys(fixture)) expect(allowedFixtureKeys.has(key), `${caseKey}: executable or unknown fixture field ${key}`)
    for (const value of Object.values(fixture)) expect(typeof value !== 'function', `${caseKey}: fixture contains an executable callback`)
  }
}

function mutate(source, from, to) {
  expect(source.includes(from), `static mutant source token missing: ${from}`)
  return source.replace(from, to)
}

function mutateLast(source, from, to) {
  const index = source.lastIndexOf(from)
  expect(index >= 0, `static mutant source token missing: ${from}`)
  return `${source.slice(0, index)}${to}${source.slice(index + from.length)}`
}

function runStaticContract(fixtures) {
  validateMatrixAndFixtures(fixtures)
  const failures = staticViolations(SOURCE, FIXTURE_SOURCE)
  expect(failures.length === 0, `auction concurrency static contract failed: ${failures.join(', ')}`)
  const marker = '// STATIC-CONTRACT-BEGIN'
  const injectExecution = (source, text) => source.replace(marker, `${text}\n${marker}`)
  const mutants = [
    ['missing-tracked-fixture', mutate(SOURCE, "from './phase45c-auction-concurrency-fixtures.mjs'", "from './missing-env-fixture.mjs'"), FIXTURE_SOURCE],
    ['env-supplied-fixture', SOURCE, `${FIXTURE_SOURCE}\nconst fixturePath = process.env.PHASE45C_FIXTURE_PATH;`],
    ['fixture-participant-injection', injectExecution(SOURCE, 'fixture.participantSql;'), FIXTURE_SOURCE],
    ['fixture-holder-injection', mutate(SOURCE, 'renderHolderPreparation(caseKey, fixture)', 'fixture.withinTransactionSql'), FIXTURE_SOURCE],
    ['malformed-sentinel', mutate(SOURCE, '\\\\echo BARRIER_ACQUIRED\n', '\\\\echo BARRIER_ACQUIRED SELECT 1;\n'), FIXTURE_SOURCE],
    ['generic-lock-observation', mutate(SOURCE, "pgrowlocks('public.auctions')", 'pg_locks'), FIXTURE_SOURCE],
    ['unscoped-waiter-query', mutate(SOURCE, 'a.query ILIKE ANY', 'a.query NOT ILIKE ALL'), FIXTURE_SOURCE],
    ['missing-explicit-release', mutate(SOURCE, 'releasedAt = Date.now()\n    holder.release()', 'releasedAt = Date.now()'), FIXTURE_SOURCE],
    ['missing-post-release-settlement', mutate(SOURCE, 'Promise.allSettled(participants)', 'Promise.resolve(participants)'), FIXTURE_SOURCE],
    ['operation-registry-bypass', mutate(SOURCE, 'renderOperation(definition.operation, fixture)', 'fixture.operationSql'), FIXTURE_SOURCE],
    ['missing-case-invariant', mutateLast(SOURCE, 'await assertCaseInvariant(caseKey, fixture)', 'void caseKey'), FIXTURE_SOURCE],
    ['missing-global-invariant', mutateLast(SOURCE, 'await assertGlobalInvariants(caseKey)', 'void caseKey'), FIXTURE_SOURCE],
    ['missing-extension-cleanup', mutateLast(SOURCE, 'await removeLocalPgrowlocksExtension(extensionWasPresent)', 'void extensionWasPresent'), FIXTURE_SOURCE],
    ['fixture-sql-field', SOURCE, mutate(FIXTURE_SOURCE, 'caseKey,', 'caseKey, setupSql: "SELECT 1",')],
  ]
  for (const [name, runtimeSource, fixtureSource] of mutants) {
    const violations = staticViolations(runtimeSource, fixtureSource)
    expect(violations.length > 0, `${name} negative mutant escaped the static contract`)
  }
  console.log(JSON.stringify({
    result: 'PHASE45C_AUCTION_CONCURRENCY_STATIC_PASS',
    cases: Object.keys(MATRIX).length,
    mutants: mutants.length,
    fixture: 'tracked-data-only',
    contention: 'holder-row-scoped',
  }))
}

// STATIC-CONTRACT-END

const fixtures = buildAuctionConcurrencyFixtures({ localOnly: true, dbContainer: DB_CONTAINER })
if (STATIC_ONLY) {
  runStaticContract(fixtures)
  process.exit(0)
}

validateMatrixAndFixtures(fixtures)
expect(/^supabase_db_[a-zA-Z0-9_.-]+$/.test(DB_CONTAINER), 'runtime gate requires an explicit local Supabase DB container name')
const extensionProbe = await mustPass(spawnPsql("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pgrowlocks');"), 'pgrowlocks preflight')
const extensionWasPresent = extensionProbe.stdout.trim() === 't'
if (!extensionWasPresent) await mustPass(spawnPsql('CREATE EXTENSION pgrowlocks;'), 'pgrowlocks local test extension')

try {
  for (const [caseKey, definition] of Object.entries(MATRIX)) {
    const fixture = fixtures[caseKey]
    await verifyCleanup(caseKey, fixture)
    try {
      await mustPass(spawnPsql(buildSetupSql(fixture)), `${caseKey}: deterministic fixture setup`)
      const overlap = await runHeldAuctionOverlap(caseKey, fixture, definition)
      verifyParticipantOutcomes(caseKey, overlap.results)
      await assertCaseInvariant(caseKey, fixture)
      await assertGlobalInvariants(caseKey)
      console.log(JSON.stringify({
        case: caseKey,
        result: 'PASS',
        participantOutcomes: overlap.results.map(result => `${result.definition.name}:${result.classification}`),
        contention: overlap.evidence,
      }))
    } finally {
      await verifyCleanup(caseKey, fixture)
    }
  }
  await assertGlobalInvariants('post-cleanup')
} finally {
  await removeLocalPgrowlocksExtension(extensionWasPresent)
}

console.log(JSON.stringify({ result: 'PHASE45C_AUCTION_CONCURRENCY_RUNTIME_PASS', cases: Object.keys(MATRIX).length }))
