-- Phase 45B concurrency acceptance approximation.
-- Run in a disposable database after 45A and 45B.  This script deliberately
-- uses one session: pg_background is not assumed to be installed.  The
-- NOWAIT row lock plus transaction advisory lock establishes the same lock
-- acquisition order used by the RPCs, then SAVEPOINTs exercise the losing
-- operation without aborting the harness transaction.  A real two-session
-- run remains required for a full race proof.
BEGIN;

INSERT INTO auth.users (id,email,raw_user_meta_data)
VALUES
 ('a0000000-0000-4000-8000-000000000011','phase45c-seller@example.test','{"username":"phase45c_seller"}'),
 ('a0000000-0000-4000-8000-000000000012','phase45c-bidder-one@example.test','{"username":"phase45c_bidder_one"}'),
 ('a0000000-0000-4000-8000-000000000022','phase45c-bidder-two@example.test','{"username":"phase45c_bidder_two"}')
ON CONFLICT (id) DO NOTHING;
UPDATE public.profiles
SET merchant_profile_completed_at=now(), merchant_bank_name='Test Bank',
    merchant_account_name='Seller', merchant_account_number='123'
WHERE id='a0000000-0000-4000-8000-000000000011';
INSERT INTO public.card_index(scryfall_id,name,set_code,collector_number)
VALUES ('b0000000-0000-4000-8000-000000000022','Phase 45C Race Card','TST','22')
ON CONFLICT (scryfall_id) DO NOTHING;
INSERT INTO public.library_cards(id,user_id,binder_id,scryfall_id,quantity)
VALUES ('c0000000-0000-4000-8000-000000000022',
        'a0000000-0000-4000-8000-000000000011',
        (SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),
        'b0000000-0000-4000-8000-000000000022',2)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.card_photos(user_id,library_card_id,storage_path)
VALUES ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000022','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000022/00000000-0000-4000-8000-000000000022.jpg')
ON CONFLICT (library_card_id) DO NOTHING;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;

CREATE TEMP TABLE phase45_concurrent_state (
  scenario text PRIMARY KEY,
  auction_id uuid NOT NULL,
  order_id uuid
) ON COMMIT DROP;

-- Bid-vs-bid: lock the auction first, let bidder one win, and prove bidder
-- two's same-amount attempt loses after the serialized state is visible.
INSERT INTO phase45_concurrent_state(scenario,auction_id)
VALUES ('bid-vs-bid',public.create_auction_draft(
  'a0000000-0000-4000-8000-000000000011','Concurrent Bid Lot',10,'any',1));
SELECT public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',auction_id,
  'c0000000-0000-4000-8000-000000000022',1)
FROM phase45_concurrent_state WHERE scenario='bid-vs-bid';
SELECT public.publish_auction('a0000000-0000-4000-8000-000000000011',auction_id)
FROM phase45_concurrent_state WHERE scenario='bid-vs-bid';
SELECT id FROM public.auctions
WHERE id=(SELECT auction_id FROM phase45_concurrent_state WHERE scenario='bid-vs-bid')
FOR UPDATE NOWAIT;
SELECT pg_try_advisory_xact_lock(hashtextextended('phase45:bid-vs-bid',0));
SAVEPOINT bid_winner;
SELECT public.place_auction_bid(auction_id,'a0000000-0000-4000-8000-000000000012',20)
FROM phase45_concurrent_state WHERE scenario='bid-vs-bid';
RELEASE SAVEPOINT bid_winner;
SAVEPOINT bid_loser;
DO $$ BEGIN
  BEGIN
    PERFORM public.place_auction_bid(auction_id,'a0000000-0000-4000-8000-000000000022',20)
    FROM phase45_concurrent_state WHERE scenario='bid-vs-bid';
    RAISE EXCEPTION 'second concurrent bid was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='second concurrent bid was accepted' OR SQLERRM<>'BID_TOO_LOW' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK TO SAVEPOINT bid_loser;
RELEASE SAVEPOINT bid_loser;
DO $$ DECLARE v_id uuid; BEGIN
  SELECT auction_id INTO v_id FROM phase45_concurrent_state WHERE scenario='bid-vs-bid';
  IF (SELECT bid_count FROM public.auctions WHERE id=v_id)<>1
     OR (SELECT current_bid_myr FROM public.auctions WHERE id=v_id)<>20
     OR (SELECT bidder_id FROM public.auction_bids WHERE auction_id=v_id)<> 'a0000000-0000-4000-8000-000000000012'
     OR (SELECT count(*) FROM public.marketplace_card_reservations WHERE source_id=v_id AND source_kind='auction')<>1 THEN
    RAISE EXCEPTION 'bid-vs-bid serialization or reservation invariant failed';
  END IF;
END $$;

-- Bid-vs-buyout: the buyout acquires the same auction row first.  The
-- simultaneous bid attempt then observes ended_sold and cannot create a bid;
-- the auction reservation is transferred to the checkout order exactly once.
INSERT INTO phase45_concurrent_state(scenario,auction_id)
VALUES ('bid-vs-buyout',public.create_auction_draft(
  'a0000000-0000-4000-8000-000000000011','Concurrent Buyout Lot',10,'any',1,50));
SELECT public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',auction_id,
  'c0000000-0000-4000-8000-000000000022',1)
FROM phase45_concurrent_state WHERE scenario='bid-vs-buyout';
SELECT public.publish_auction('a0000000-0000-4000-8000-000000000011',auction_id)
FROM phase45_concurrent_state WHERE scenario='bid-vs-buyout';
SELECT id FROM public.auctions
WHERE id=(SELECT auction_id FROM phase45_concurrent_state WHERE scenario='bid-vs-buyout')
FOR UPDATE NOWAIT;
SELECT pg_try_advisory_xact_lock(hashtextextended('phase45:bid-vs-buyout',0));
SAVEPOINT buyout_winner;
UPDATE phase45_concurrent_state
SET order_id=(public.checkout_auction_buyout(
  'a0000000-0000-4000-8000-000000000022',
  'b1000000-0000-4000-8000-000000000022',
  (SELECT id FROM public.pickup_locations WHERE active LIMIT 1),
  auction_id)->'order_ids'->>0)::uuid
WHERE scenario='bid-vs-buyout';
RELEASE SAVEPOINT buyout_winner;
SAVEPOINT bid_after_buyout;
DO $$ BEGIN
  BEGIN
    PERFORM public.place_auction_bid(auction_id,'a0000000-0000-4000-8000-000000000012',20)
    FROM phase45_concurrent_state WHERE scenario='bid-vs-buyout';
    RAISE EXCEPTION 'simultaneous bid after buyout was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='simultaneous bid after buyout was accepted' OR SQLERRM<>'AUCTION_ENDED' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK TO SAVEPOINT bid_after_buyout;
RELEASE SAVEPOINT bid_after_buyout;
DO $$ DECLARE v_id uuid; v_order uuid; BEGIN
  SELECT auction_id,order_id INTO v_id,v_order FROM phase45_concurrent_state WHERE scenario='bid-vs-buyout';
  IF NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_id AND status='ended_sold' AND winner_id='a0000000-0000-4000-8000-000000000022')
     OR EXISTS(SELECT 1 FROM public.auction_bids WHERE auction_id=v_id)
     OR EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id=v_id)
     OR (SELECT count(*) FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=v_order AND reserved_quantity=1)<>1 THEN
    RAISE EXCEPTION 'buyout did not win or reservation transfer was incorrect';
  END IF;
END $$;

-- No psql meta-commands are used; all fixture state is rolled back here.
ROLLBACK;
