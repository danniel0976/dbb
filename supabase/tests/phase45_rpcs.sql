-- Phase 45B disposable SQL/RPC tests. Run only in a local disposable database.
-- No psql meta-commands are used; the transaction is rolled back at the end.
BEGIN;

INSERT INTO auth.users (id,email,raw_user_meta_data)
VALUES
 ('a0000000-0000-4000-8000-000000000011','phase45b-seller@example.test','{"username":"phase45b_seller"}'),
 ('a0000000-0000-4000-8000-000000000012','phase45b-bidder@example.test','{"username":"phase45b_bidder"}')
ON CONFLICT (id) DO NOTHING;
UPDATE public.profiles SET merchant_profile_completed_at=now(), merchant_bank_name='Test Bank', merchant_account_name='Seller', merchant_account_number='123' WHERE id='a0000000-0000-4000-8000-000000000011';
INSERT INTO public.card_index(scryfall_id,name,set_code,collector_number)
VALUES
 ('b0000000-0000-4000-8000-000000000011','Phase 45B Card One','TST','1'),
 ('b0000000-0000-4000-8000-000000000012','Phase 45B Card Two','TST','2'),
 ('b0000000-0000-4000-8000-000000000013','Phase 45B Card Three','TST','3'),
 ('b0000000-0000-4000-8000-000000000014','Phase 45B Card Four','TST','4'),
 ('b0000000-0000-4000-8000-000000000015','Phase 45B Card Five','TST','5'),
 ('b0000000-0000-4000-8000-000000000016','Phase 45B Card Six','TST','6'),
 ('b0000000-0000-4000-8000-000000000017','Phase 45B Card Seven','TST','7'),
 ('b0000000-0000-4000-8000-000000000018','Phase 45B Card Eight','TST','8'),
 ('b0000000-0000-4000-8000-000000000019','Phase 45B Card Nine','TST','9'),
 ('b0000000-0000-4000-8000-000000000020','Phase 45B Card Ten','TST','10'),
 ('b0000000-0000-4000-8000-000000000021','Phase 45B Card Eleven','TST','11')
ON CONFLICT (scryfall_id) DO NOTHING;
INSERT INTO public.library_cards(id,user_id,binder_id,scryfall_id,quantity)
VALUES
 ('c0000000-0000-4000-8000-000000000011','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000011',4),
 ('c0000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000012',4),
 ('c0000000-0000-4000-8000-000000000013','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000013',4),
 ('c0000000-0000-4000-8000-000000000014','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000014',4),
 ('c0000000-0000-4000-8000-000000000015','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000015',4),
 ('c0000000-0000-4000-8000-000000000016','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000016',4),
 ('c0000000-0000-4000-8000-000000000017','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000017',1),
 ('c0000000-0000-4000-8000-000000000018','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000018',1),
 ('c0000000-0000-4000-8000-000000000019','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000019',4),
 ('c0000000-0000-4000-8000-000000000020','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000020',4),
 ('c0000000-0000-4000-8000-000000000021','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000021',4)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.card_photos(user_id,library_card_id,storage_path)
VALUES
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000011','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000011/00000000-0000-4000-8000-000000000011.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000012/00000000-0000-4000-8000-000000000012.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000013','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000013/00000000-0000-4000-8000-000000000013.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000014','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000014/00000000-0000-4000-8000-000000000014.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000015','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000015/00000000-0000-4000-8000-000000000015.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000016','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000016/00000000-0000-4000-8000-000000000016.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000017','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000017/00000000-0000-4000-8000-000000000017.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000018','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000018/00000000-0000-4000-8000-000000000018.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000019','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000019/00000000-0000-4000-8000-000000000019.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000020','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000020/00000000-0000-4000-8000-000000000020.jpg'),
 ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000021','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000021/00000000-0000-4000-8000-000000000021.jpg')
ON CONFLICT (library_card_id) DO NOTHING;
UPDATE public.library_cards SET foil='etched' WHERE id='c0000000-0000-4000-8000-000000000014';
-- Production service-role calls do not put the seller in auth.uid(); every
-- seller-scoped RPC receives the separately authenticated seller UUID.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET LOCAL ROLE service_role;

-- A. Create draft: happy path and validation errors.
DO $$ DECLARE v_id uuid; BEGIN
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Test Lot',10,'5',3,100,false);
  IF NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_id AND status='draft') THEN RAISE EXCEPTION 'valid draft was not inserted'; END IF;
  BEGIN PERFORM public.create_auction_draft('a0000000-0000-4000-8000-000000000011','ab',10,'5',3); RAISE EXCEPTION 'short title accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'TITLE_TOO_SHORT' THEN RAISE; END IF; END;
  BEGIN PERFORM public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Valid Lot',10,'invalid',3); RAISE EXCEPTION 'invalid increment accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'INVALID_INCREMENT' THEN RAISE; END IF; END;
END $$;

-- C/E: assemble and publish a happy-path lot, with snapshots/reservations.
DO $$ DECLARE v_id uuid; v_out jsonb; BEGIN
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Publishable Lot',10,'5',3,100,true);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000011',2);
  v_out:=public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  IF (v_out->>'item_count')::integer<>1 OR NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_id AND status='active') THEN RAISE EXCEPTION 'publish result/status wrong'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=v_id AND reserved_quantity=2) THEN RAISE EXCEPTION 'publish reservation missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.auction_items WHERE auction_id=v_id AND scryfall_id IS NOT NULL AND card_name='Phase 45B Card One') THEN RAISE EXCEPTION 'publish snapshot missing'; END IF;
  BEGIN PERFORM public.update_auction_draft('a0000000-0000-4000-8000-000000000011',v_id,'New title'); RAISE EXCEPTION 'active auction was editable'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'AUCTION_NOT_DRAFT' THEN RAISE; END IF; END;
END $$;

-- Publish with no items.
DO $$ DECLARE v_id uuid; BEGIN
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Empty Lot',10,'any',1);
  BEGIN PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id); RAISE EXCEPTION 'empty lot published'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'NO_LOT_ITEMS' THEN RAISE; END IF; END;
END $$;

-- E: seller, floor, buyout guard, accepted bid, and soft-close extension.
-- Accepted W2 design warning: these direct-access probes are intentionally
-- weak privilege coverage; INSERT targets a nonexistent auction and there is
-- no has_table_privilege assertion (see the dedicated access checks below).
DO $$ DECLARE v_id uuid; v_out jsonb; v_old timestamptz; BEGIN
  SELECT id INTO v_id FROM public.auctions WHERE title='Publishable Lot';
  BEGIN PERFORM public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000011',11); RAISE EXCEPTION 'seller bid accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'SELLER_CANNOT_BID' THEN RAISE; END IF; END;
  BEGIN PERFORM public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',9); RAISE EXCEPTION 'low bid accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BID_TOO_LOW' THEN RAISE; END IF; END;
  BEGIN PERFORM public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',100); RAISE EXCEPTION 'buyout bid accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'USE_BUYOUT' THEN RAISE; END IF; END;
  UPDATE public.auctions SET expires_at=now()+interval '4 minutes' WHERE id=v_id;
  SELECT expires_at INTO v_old FROM public.auctions WHERE id=v_id;
  v_out:=public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',10);
  IF (v_out->>'bid_count')::integer<>1 OR (v_out->>'current_bid_myr')::integer<>10 OR (v_out->>'soft_close_extension_minutes')::integer<>5 OR (v_out->>'expires_at')::timestamptz<=v_old THEN RAISE EXCEPTION 'accepted bid/soft close failed'; END IF;
  UPDATE public.auctions SET expires_at=now()+interval '4 minutes' WHERE id=v_id; PERFORM public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',15);
  UPDATE public.auctions SET expires_at=now()+interval '4 minutes' WHERE id=v_id; PERFORM public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',20);
  UPDATE public.auctions SET expires_at=now()+interval '4 minutes' WHERE id=v_id;
  v_out:=public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',25);
  IF (v_out->>'soft_close_extension_minutes')::integer<>15 THEN RAISE EXCEPTION 'soft-close cap was not enforced'; END IF;
END $$;

-- H: extension uses old expiry + N, and exact key replay returns the same metadata.
DO $$ DECLARE v_id uuid; v_before timestamptz; v_after timestamptz; v_replay jsonb; v_first jsonb; BEGIN
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Extension Lot',10,'any',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000012',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  SELECT expires_at INTO v_before FROM public.auctions WHERE id=v_id;
  v_first:=public.extend_auction(v_id,'a0000000-0000-4000-8000-000000000011',30,'test-key');
  v_after:=(v_first->>'expires_at')::timestamptz;
  IF v_after < v_before+interval '29 minutes' OR v_after > v_before+interval '31 minutes' THEN RAISE EXCEPTION 'extension did not use old expiry'; END IF;
  v_replay:=public.extend_auction(v_id,'a0000000-0000-4000-8000-000000000011',30,'test-key');
  IF v_replay<>v_first THEN RAISE EXCEPTION 'extension replay was not authoritative'; END IF;
  BEGIN PERFORM public.extend_auction(v_id,'a0000000-0000-4000-8000-000000000011',15,'second'); RAISE EXCEPTION 'second extension accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'EXTENSION_ALREADY_USED' THEN RAISE; END IF; END;
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Invalid Extension Lot',10,'any',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000013',1); PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  BEGIN PERFORM public.extend_auction(v_id,'a0000000-0000-4000-8000-000000000011',25,'bad'); RAISE EXCEPTION 'invalid extension accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'INVALID_EXTENSION' THEN RAISE; END IF; END;
END $$;

-- Ended extension precedence: lifecycle state wins over extension reuse and
-- invalid-minute checks, then restore the fixture for subsequent expiry tests.
DO $$ DECLARE v_id uuid; v_out jsonb; BEGIN
  SELECT id INTO v_id FROM public.auctions WHERE title='Extension Lot';
  UPDATE public.auctions SET expires_at=now()-interval '1 minute' WHERE id=v_id;
  BEGIN
    v_out:=public.extend_auction(v_id,'a0000000-0000-4000-8000-000000000011',15,'ended-fresh-key');
    RAISE EXCEPTION 'expired auction extension accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM<>'AUCTION_ENDED' THEN RAISE; END IF;
  END;
  UPDATE public.auctions SET status='ended_sold' WHERE id=v_id;
  BEGIN
    v_out:=public.extend_auction(v_id,'a0000000-0000-4000-8000-000000000011',15,'inactive-fresh-key');
    RAISE EXCEPTION 'inactive auction extension accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM<>'AUCTION_ENDED' THEN RAISE; END IF;
  END;
  UPDATE public.auctions SET status='active',expires_at=now()+interval '4 minutes' WHERE id=v_id;
END $$;

-- J/I: no-bid expiry releases reservations; bid expiry retains them and records winner.
DO $$ DECLARE v_no uuid; v_bid uuid; v_n integer; BEGIN
  SELECT id INTO v_no FROM public.auctions WHERE title='Extension Lot'; UPDATE public.auctions SET expires_at=now()-interval '1 minute' WHERE id=v_no;
  SELECT public.settle_expired_auctions(50,now()) INTO v_n;
  IF NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_no AND status='expired') OR EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id=v_no) THEN RAISE EXCEPTION 'no-bid settlement failed'; END IF;
  SELECT id INTO v_bid FROM public.auctions WHERE title='Publishable Lot'; UPDATE public.auctions SET expires_at=now()-interval '1 minute' WHERE id=v_bid;
  PERFORM public.settle_expired_auctions(50,now());
  IF NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_bid AND status='ended_pending_winner' AND winner_id='a0000000-0000-4000-8000-000000000012') OR NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id=v_bid) THEN RAISE EXCEPTION 'bid settlement failed'; END IF;
END $$;

-- I: relist expired no-bid auction creates a fresh record with no bids.
DO $$ DECLARE v_old uuid; v_new uuid; BEGIN
  SELECT id INTO v_old FROM public.auctions WHERE title='Extension Lot';
  v_new:=public.relist_auction('a0000000-0000-4000-8000-000000000011',v_old,3);
  IF v_new=v_old OR NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_new AND status='active' AND relisted_from_auction_id=v_old AND bid_count=0 AND expires_at>now()) THEN RAISE EXCEPTION 'relist did not create a fresh auction'; END IF;
END $$;

-- B7/B8: clear buyout, edit/remove draft items, and enforce amount maxima.
DO $$ DECLARE v_id uuid; BEGIN
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Editable Lot',10,'any',1,50,false);
  PERFORM public.update_auction_draft('a0000000-0000-4000-8000-000000000011',v_id,NULL,NULL,NULL,NULL,NULL,NULL,true);
  IF EXISTS(SELECT 1 FROM public.auctions WHERE id=v_id AND buyout_myr IS NOT NULL) THEN RAISE EXCEPTION 'buyout was not clearable'; END IF;
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000014',2);
  PERFORM public.update_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000014',1);
  IF (SELECT quantity FROM public.auction_items WHERE auction_id=v_id)<>1 THEN RAISE EXCEPTION 'draft quantity was not updated'; END IF;
  PERFORM public.remove_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000014');
  IF EXISTS(SELECT 1 FROM public.auction_items WHERE auction_id=v_id) THEN RAISE EXCEPTION 'draft item was not removed'; END IF;
  BEGIN PERFORM public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Too High',100000,'any',1); RAISE EXCEPTION 'starting max missing'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'STARTING_BID_TOO_HIGH' THEN RAISE; END IF; END;
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Update Max',10,'any',1);
  BEGIN PERFORM public.update_auction_draft('a0000000-0000-4000-8000-000000000011',v_id,NULL,100000); RAISE EXCEPTION 'update starting max missing'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'STARTING_BID_TOO_HIGH' THEN RAISE; END IF; END;
  BEGIN PERFORM public.update_auction_draft('a0000000-0000-4000-8000-000000000011',v_id,NULL,NULL,NULL,NULL,100000); RAISE EXCEPTION 'update buyout max missing'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BUYOUT_TOO_HIGH' THEN RAISE; END IF; END;
  BEGIN PERFORM public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Buyout Max',10,'any',1,100000); RAISE EXCEPTION 'buyout max missing'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BUYOUT_TOO_HIGH' THEN RAISE; END IF; END;
END $$;

-- B6/B5/B9: buyout checkout, etched finish, sen allocation, and exact replay.
DO $$ DECLARE v_id uuid; v_key uuid:='b1000000-0000-4000-8000-000000000001'; v_pickup uuid; v_first jsonb; v_replay jsonb; BEGIN
  SELECT id INTO v_pickup FROM public.pickup_locations WHERE active LIMIT 1;
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Buyout Lot',10,'any',1,100,false);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000014',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  IF NOT EXISTS(SELECT 1 FROM public.auction_items WHERE auction_id=v_id AND finish='etched') THEN RAISE EXCEPTION 'etched finish snapshot lost'; END IF;
  v_first:=public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012',v_key,v_pickup,v_id);
  v_replay:=public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012',v_key,v_pickup,v_id);
  IF v_first<>v_replay OR v_first->>'result_code'<>'CHECKOUT_COMPLETE' THEN RAISE EXCEPTION 'buyout replay mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.order_items oi WHERE oi.order_id=(v_first->'order_ids'->>0)::uuid AND oi.finish='etched') THEN RAISE EXCEPTION 'order finish snapshot lost'; END IF;
  IF EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=v_id)
     OR NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=(v_first->'order_ids'->>0)::uuid AND reserved_quantity=1) THEN
    RAISE EXCEPTION 'buyout reservation was not transferred';
  END IF;
END $$;

-- Phase 45C Auction idempotency: only an exact immutable action/auction/pickup
-- intent may replay.  Pickup or auction changes using the same key must make
-- no second order or reservation write for both buyout and winner claim.
DO $$
DECLARE
  v_pickup uuid;
  v_other_pickup uuid := 'd1000000-0000-4000-8000-000000000001';
  v_buyout_a uuid;
  v_buyout_b uuid;
  v_claim_a uuid;
  v_claim_b uuid;
  v_first jsonb;
  v_replay jsonb;
  v_orders integer;
  v_reservations integer;
BEGIN
  SELECT id INTO v_pickup FROM public.pickup_locations WHERE active LIMIT 1;
  INSERT INTO public.pickup_locations(id,slug,name,address,active,is_default)
  VALUES(v_other_pickup,'phase45c-idempotency-alt','Phase 45C Alternate','Test address',true,false)
  ON CONFLICT (id) DO UPDATE SET active=true;
  INSERT INTO public.card_index(scryfall_id,name,set_code,collector_number) VALUES
    ('b0000000-0000-4000-8000-000000000022','Phase 45C Idempotency One','TST','22'),
    ('b0000000-0000-4000-8000-000000000023','Phase 45C Idempotency Two','TST','23'),
    ('b0000000-0000-4000-8000-000000000024','Phase 45C Idempotency Three','TST','24'),
    ('b0000000-0000-4000-8000-000000000025','Phase 45C Idempotency Four','TST','25')
  ON CONFLICT (scryfall_id) DO NOTHING;
  INSERT INTO public.library_cards(id,user_id,binder_id,scryfall_id,quantity) VALUES
    ('c0000000-0000-4000-8000-000000000022','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000022',1),
    ('c0000000-0000-4000-8000-000000000023','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000023',1),
    ('c0000000-0000-4000-8000-000000000024','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000024',1),
    ('c0000000-0000-4000-8000-000000000025','a0000000-0000-4000-8000-000000000011',(SELECT id FROM public.binders WHERE user_id='a0000000-0000-4000-8000-000000000011'),'b0000000-0000-4000-8000-000000000025',1)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.card_photos(user_id,library_card_id,storage_path) VALUES
    ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000022','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000022/00000000-0000-4000-8000-000000000022.jpg'),
    ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000023','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000023/00000000-0000-4000-8000-000000000023.jpg'),
    ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000024','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000024/00000000-0000-4000-8000-000000000024.jpg'),
    ('a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000025','a0000000-0000-4000-8000-000000000011/c0000000-0000-4000-8000-000000000025/00000000-0000-4000-8000-000000000025.jpg')
  ON CONFLICT (library_card_id) DO NOTHING;

  v_buyout_a:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Idempotent Buyout A',10,'any',1,100);
  v_buyout_b:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Idempotent Buyout B',10,'any',1,100);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_buyout_a,'c0000000-0000-4000-8000-000000000022',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_buyout_b,'c0000000-0000-4000-8000-000000000023',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_buyout_a);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_buyout_b);
  v_first:=public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000022',v_pickup,v_buyout_a);
  v_replay:=public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000022',v_pickup,v_buyout_a);
  IF v_first<>v_replay OR v_first->>'result_code'<>'CHECKOUT_COMPLETE' THEN RAISE EXCEPTION 'exact buyout replay failed'; END IF;
  SELECT count(*) INTO v_orders FROM public.orders;
  SELECT count(*) INTO v_reservations FROM public.marketplace_card_reservations;
  BEGIN PERFORM public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000022',v_other_pickup,v_buyout_a); RAISE EXCEPTION 'changed buyout pickup replay accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF; END;
  BEGIN PERFORM public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000022',v_pickup,v_buyout_b); RAISE EXCEPTION 'changed buyout auction replay accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF; END;
  IF (SELECT count(*) FROM public.orders)<>v_orders OR (SELECT count(*) FROM public.marketplace_card_reservations)<>v_reservations OR EXISTS(SELECT 1 FROM public.auctions WHERE id=v_buyout_b AND status<>'active') THEN RAISE EXCEPTION 'changed buyout intent wrote rows'; END IF;

  v_claim_a:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Idempotent Claim A',10,'any',1);
  v_claim_b:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Idempotent Claim B',10,'any',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_claim_a,'c0000000-0000-4000-8000-000000000024',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_claim_b,'c0000000-0000-4000-8000-000000000025',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_claim_a);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_claim_b);
  PERFORM public.place_auction_bid(v_claim_a,'a0000000-0000-4000-8000-000000000012',10);
  PERFORM public.place_auction_bid(v_claim_b,'a0000000-0000-4000-8000-000000000012',10);
  UPDATE public.auctions SET expires_at=now()-interval '1 minute' WHERE id IN (v_claim_a,v_claim_b);
  PERFORM public.settle_expired_auctions(50,now());
  v_first:=public.checkout_auction_claim('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000023',v_pickup,v_claim_a);
  v_replay:=public.checkout_auction_claim('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000023',v_pickup,v_claim_a);
  IF v_first<>v_replay OR v_first->>'result_code'<>'CHECKOUT_COMPLETE' THEN RAISE EXCEPTION 'exact claim replay failed'; END IF;
  SELECT count(*) INTO v_orders FROM public.orders;
  SELECT count(*) INTO v_reservations FROM public.marketplace_card_reservations;
  BEGIN PERFORM public.checkout_auction_claim('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000023',v_other_pickup,v_claim_a); RAISE EXCEPTION 'changed claim pickup replay accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF; END;
  BEGIN PERFORM public.checkout_auction_claim('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000023',v_pickup,v_claim_b); RAISE EXCEPTION 'changed claim auction replay accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF; END;
  IF (SELECT count(*) FROM public.orders)<>v_orders OR (SELECT count(*) FROM public.marketplace_card_reservations)<>v_reservations OR EXISTS(SELECT 1 FROM public.auctions WHERE id=v_claim_b AND status<>'ended_pending_winner') THEN RAISE EXCEPTION 'changed claim intent wrote rows'; END IF;
END $$;

-- Lazy buyout expiry commits AUCTION_ENDED and replays that non-checkout
-- result, never the generic CHECKOUT_COMPLETE marker.
DO $$ DECLARE v_id uuid; v_pickup uuid; v_first jsonb; v_replay jsonb; v_key uuid:='b1000000-0000-4000-8000-000000000005'; BEGIN
  SELECT id INTO v_pickup FROM public.pickup_locations WHERE active LIMIT 1;
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Expired Buyout Lot',10,'any',1,100,false);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000016',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  UPDATE public.auctions SET expires_at=now()-interval '1 minute' WHERE id=v_id;
  v_first:=public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012',v_key,v_pickup,v_id);
  v_replay:=public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012',v_key,v_pickup,v_id);
  IF v_first->>'result_code'<>'AUCTION_ENDED' OR v_replay->>'result_code'<>'AUCTION_ENDED' OR v_first<>v_replay
     OR NOT EXISTS(SELECT 1 FROM public.checkout_requests WHERE buyer_id='a0000000-0000-4000-8000-000000000012' AND idempotency_key=v_key AND result_code='AUCTION_ENDED')
     OR EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id=v_id) THEN
    RAISE EXCEPTION 'lazy buyout expiry replay failed';
  END IF;
END $$;

-- B1/B9: expired bid path commits its demotion and returns a structured result.
DO $$ DECLARE v_id uuid; v_out jsonb; BEGIN
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Lazy Expiry Lot',10,'any',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000016',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  UPDATE public.auctions SET expires_at=now()-interval '1 minute' WHERE id=v_id;
  v_out:=public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',10);
  IF v_out->>'result_code'<>'AUCTION_ENDED' OR NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_id AND status='expired') OR EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id=v_id) THEN RAISE EXCEPTION 'lazy bid expiry did not persist'; END IF;
END $$;

-- Claim normal path and claim-window lazy demotion; settle an unclaimed win
-- separately to verify its 24-hour relist_available transition.
DO $$ DECLARE v_id uuid; v_expired uuid; v_pickup uuid; v_key uuid:='b1000000-0000-4000-8000-000000000002'; v_out jsonb; v_first_claim jsonb; BEGIN
  SELECT id INTO v_pickup FROM public.pickup_locations WHERE active LIMIT 1;
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Claim Lot',10,'any',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000015',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  v_out:=public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',10);
  -- Bid while active, then expire and settle it into the winner-claim state.
  UPDATE public.auctions SET expires_at=now()-interval '1 minute' WHERE id=v_id;
  PERFORM public.settle_expired_auctions(50,now());
  v_out:=public.checkout_auction_claim('a0000000-0000-4000-8000-000000000012',v_key,v_pickup,v_id);
  IF v_out->>'result_code'<>'CHECKOUT_COMPLETE' OR NOT EXISTS(SELECT 1 FROM public.order_items WHERE order_id=(v_out->'order_ids'->>0)::uuid AND finish='normal') THEN RAISE EXCEPTION 'claim checkout failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='auction' AND source_id=v_id)
     OR NOT EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_kind='order' AND source_id=(v_out->'order_ids'->>0)::uuid AND reserved_quantity=1) THEN
    RAISE EXCEPTION 'claim reservation was not transferred';
  END IF;

  v_expired:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Expired Claim Lot',10,'any',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_expired,'c0000000-0000-4000-8000-000000000018',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_expired);
  UPDATE public.auctions SET status='ended_pending_winner',winner_id='a0000000-0000-4000-8000-000000000012',current_bid_myr=10,won_at=now()-interval '25 hours' WHERE id=v_expired;
  v_first_claim:=public.checkout_auction_claim('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000003',v_pickup,v_expired);
  IF v_first_claim->>'result_code'<>'CLAIM_WINDOW_EXPIRED' OR NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_expired AND status='relist_available') THEN RAISE EXCEPTION 'lazy claim demotion did not persist'; END IF;
  v_out:=public.checkout_auction_claim('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000003',v_pickup,v_expired);
  IF v_first_claim<>v_out THEN RAISE EXCEPTION 'lazy claim expiry replay was not exact'; END IF;
  IF v_out->>'result_code'<>'CLAIM_WINDOW_EXPIRED' OR v_out->'order_ids' <> '[]'::jsonb
     OR NOT EXISTS(SELECT 1 FROM public.checkout_requests WHERE buyer_id='a0000000-0000-4000-8000-000000000012' AND idempotency_key='b1000000-0000-4000-8000-000000000003' AND result_code='CLAIM_WINDOW_EXPIRED')
     OR EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id=v_expired) THEN
    RAISE EXCEPTION 'lazy claim expiry replay failed';
  END IF;
END $$;

-- B5: skewed [3,3,1] lot has exact quantity proportions, a stable
-- remainder recipient, whole-MYR snapshots, and per-copy rounding.
DO $$ DECLARE v_id uuid; v_pickup uuid; v_out jsonb; v_sum numeric; v_zero integer; v_first_qty integer; v_first_sen bigint; v_first_alloc integer; BEGIN
  SELECT id INTO v_pickup FROM public.pickup_locations WHERE active LIMIT 1;
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Skewed Lot',10,'any',1,100,false);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000019',3);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000020',3);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000021',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  v_out:=public.checkout_auction_buyout('a0000000-0000-4000-8000-000000000012','b1000000-0000-4000-8000-000000000004',v_pickup,v_id);
  SELECT sum(line_myr),count(*) FILTER (WHERE line_myr<=0) INTO v_sum,v_zero FROM public.order_items WHERE order_id=(v_out->'order_ids'->>0)::uuid;
  SELECT oi.quantity,round(oi.line_myr*100)::bigint,ai.allocation_weight_myr INTO v_first_qty,v_first_sen,v_first_alloc
  FROM public.order_items oi JOIN public.auction_items ai ON ai.id=oi.auction_item_id
  WHERE oi.order_id=(v_out->'order_ids'->>0)::uuid ORDER BY ai.id LIMIT 1;
  -- The RPC orders by auction_items.id, and gives its full two-sen remainder
  -- to that lowest UUID.  Assert the same order, including either possible
  -- quantity-1 placement, so generated UUIDs cannot make this flaky.
  IF v_sum<>100 OR v_zero<>0 OR v_first_sen<>(CASE v_first_qty WHEN 3 THEN 4286 ELSE 1430 END)
     OR v_first_alloc<>(CASE v_first_qty WHEN 3 THEN 43 ELSE 15 END) THEN
    RAISE EXCEPTION 'skewed allocation remainder failed'; END IF;
  IF (SELECT count(*) FROM public.order_items WHERE order_id=(v_out->'order_ids'->>0)::uuid AND quantity=3 AND round(line_myr*100)::bigint=4285) <> (CASE WHEN v_first_qty=3 THEN 1 ELSE 2 END)
     OR (SELECT count(*) FROM public.order_items WHERE order_id=(v_out->'order_ids'->>0)::uuid AND quantity=3)<>2
     OR (SELECT count(*) FROM public.order_items WHERE order_id=(v_out->'order_ids'->>0)::uuid AND quantity=1 AND round(line_myr*100)::bigint=(CASE WHEN v_first_qty=1 THEN 1430 ELSE 1429 END))<>1
     -- unit_myr is stored at two decimals, so multiplying a rounded per-copy
     -- value may differ from the authoritative line by at most one sen.
     OR EXISTS(SELECT 1 FROM public.order_items WHERE order_id=(v_out->'order_ids'->>0)::uuid AND abs(round(unit_myr*quantity,2)-round(line_myr,2))>0.01) THEN
    RAISE EXCEPTION 'skewed allocation proportions or per-copy rounding failed';
  END IF;
END $$;

-- Maxima and current_bid + step overflow are distinct bid guards.
DO $$ DECLARE v_id uuid; BEGIN
  v_id:=public.create_auction_draft('a0000000-0000-4000-8000-000000000011','Bid Maxima Lot',99998,'5',1);
  PERFORM public.add_auction_draft_item('a0000000-0000-4000-8000-000000000011',v_id,'c0000000-0000-4000-8000-000000000017',1);
  PERFORM public.publish_auction('a0000000-0000-4000-8000-000000000011',v_id);
  BEGIN PERFORM public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',100000); RAISE EXCEPTION 'bid amount max missing'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BID_TOO_HIGH' THEN RAISE; END IF; END;
  PERFORM public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',99998);
  BEGIN PERFORM public.place_auction_bid(v_id,'a0000000-0000-4000-8000-000000000012',99999); RAISE EXCEPTION 'bid floor overflow missing'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BID_TOO_HIGH' THEN RAISE; END IF; END;
  IF NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_id AND current_bid_myr=99998 AND bid_count=1) THEN RAISE EXCEPTION 'bid maximum state incorrect'; END IF;
END $$;

-- B4/B9: unclaimed-win demotion and order completion releases reservation
-- before deleting an exact-quantity card row.
DO $$ DECLARE v_id uuid; v_order uuid; v_pickup uuid; BEGIN
  SELECT id INTO v_id FROM public.auctions WHERE title='Publishable Lot';
  UPDATE public.auctions SET won_at=now()-interval '25 hours' WHERE id=v_id;
  PERFORM public.settle_expired_auctions(50,now());
  IF NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_id AND status='relist_available') THEN RAISE EXCEPTION 'unclaimed win not demoted'; END IF;
  SELECT id INTO v_pickup FROM public.pickup_locations WHERE active LIMIT 1;
  -- The maxima fixture intentionally remains a live one-bid auction.  Release
  -- its auction reservation before exercising exact-quantity card deletion.
  DELETE FROM public.marketplace_card_reservations
  WHERE source_kind='auction' AND source_id=(SELECT id FROM public.auctions WHERE title='Bid Maxima Lot');
  INSERT INTO public.orders(id,buyer_id,seller_id,pickup_location_id,status,total_myr) VALUES('f0000000-0000-4000-8000-000000000045','a0000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-000000000011',v_pickup,'dropped_off',10);
  INSERT INTO public.order_items(order_id,library_card_id,quantity,unit_myr,line_myr,multiplier,price_source,scryfall_id,card_name)
  VALUES('f0000000-0000-4000-8000-000000000045','c0000000-0000-4000-8000-000000000017',1,10,10,1,'single_multiplier','b0000000-0000-4000-8000-000000000017','Phase 45B Card Seven');
  INSERT INTO public.marketplace_card_reservations(library_card_id,owner_id,source_kind,source_id,reserved_quantity) VALUES('c0000000-0000-4000-8000-000000000017','a0000000-0000-4000-8000-000000000011','order','f0000000-0000-4000-8000-000000000045',1);
  PERFORM public.transition_order('f0000000-0000-4000-8000-000000000045','a0000000-0000-4000-8000-000000000012','order_completed');
  IF EXISTS(SELECT 1 FROM public.library_cards WHERE id='c0000000-0000-4000-8000-000000000017') OR EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id='f0000000-0000-4000-8000-000000000045') THEN RAISE EXCEPTION 'exact quantity completion did not release/delete'; END IF;
END $$;

-- B4: Singles cancellation restores the listing and releases its reservation;
-- auction cancellation reaches relist_available and releases its reservation.
DO $$ DECLARE v_pickup uuid; v_listing uuid:='f1000000-0000-4000-8000-000000000045'; v_aid uuid; BEGIN
  SELECT id INTO v_pickup FROM public.pickup_locations WHERE active LIMIT 1;
  INSERT INTO public.listings(id,user_id,library_card_id,status,quantity,expires_at,multiplier)
  VALUES(v_listing,'a0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000015','reserved',0,now()+interval '1 day',2.5);
  INSERT INTO public.orders(id,buyer_id,seller_id,pickup_location_id,status,total_myr) VALUES('f0000000-0000-4000-8000-000000000046','a0000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-000000000011',v_pickup,'awaiting_payment',10);
  INSERT INTO public.order_items(order_id,listing_id,library_card_id,quantity,unit_myr,line_myr,multiplier,price_source,scryfall_id,card_name)
  VALUES('f0000000-0000-4000-8000-000000000046',v_listing,'c0000000-0000-4000-8000-000000000015',1,10,10,1,'single_multiplier','b0000000-0000-4000-8000-000000000015','Phase 45B Card Five');
  INSERT INTO public.marketplace_card_reservations(library_card_id,owner_id,source_kind,source_id,reserved_quantity) VALUES('c0000000-0000-4000-8000-000000000015','a0000000-0000-4000-8000-000000000011','order','f0000000-0000-4000-8000-000000000046',1);
  PERFORM public.transition_order('f0000000-0000-4000-8000-000000000046','a0000000-0000-4000-8000-000000000011','cancel','test cancellation');
  IF NOT EXISTS(SELECT 1 FROM public.listings WHERE id=v_listing AND status='active' AND quantity=1) OR EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id='f0000000-0000-4000-8000-000000000046') THEN RAISE EXCEPTION 'single cancellation regression'; END IF;

  SELECT id INTO v_aid FROM public.auctions WHERE title='Expired Claim Lot';
  INSERT INTO public.orders(id,buyer_id,seller_id,pickup_location_id,status,total_myr) VALUES('f0000000-0000-4000-8000-000000000047','a0000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-000000000011',v_pickup,'awaiting_payment',10);
  INSERT INTO public.order_items(order_id,library_card_id,quantity,unit_myr,line_myr,multiplier,price_source,auction_id,scryfall_id,card_name)
  VALUES('f0000000-0000-4000-8000-000000000047','c0000000-0000-4000-8000-000000000018',1,10,10,NULL,'auction_bid',v_aid,'b0000000-0000-4000-8000-000000000018','Phase 45B Card Eight');
  INSERT INTO public.marketplace_card_reservations(library_card_id,owner_id,source_kind,source_id,reserved_quantity) VALUES('c0000000-0000-4000-8000-000000000018','a0000000-0000-4000-8000-000000000011','order','f0000000-0000-4000-8000-000000000047',1);
  UPDATE public.auctions SET status='ended_sold' WHERE id=v_aid;
  PERFORM public.transition_order('f0000000-0000-4000-8000-000000000047','a0000000-0000-4000-8000-000000000011','cancel','auction cancellation');
  IF NOT EXISTS(SELECT 1 FROM public.auctions WHERE id=v_aid AND status='relist_available') OR EXISTS(SELECT 1 FROM public.marketplace_card_reservations WHERE source_id='f0000000-0000-4000-8000-000000000047') THEN RAISE EXCEPTION 'auction cancellation regression'; END IF;
END $$;

-- B9: authenticated clients have no direct bid INSERT or SELECT path.
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN INSERT INTO public.auction_bids(auction_id,bidder_id,amount_myr) VALUES('00000000-0000-0000-0000-000000000001','a0000000-0000-4000-8000-000000000012',10); RAISE EXCEPTION 'authenticated bid INSERT was accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM='authenticated bid INSERT was accepted' THEN RAISE; END IF; END;
  BEGIN PERFORM 1 FROM public.auction_bids; RAISE EXCEPTION 'authenticated bid SELECT was accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM='authenticated bid SELECT was accepted' THEN RAISE; END IF; END;
END $$;
RESET ROLE;

RESET ROLE;

-- Service-role-only execution boundary (schema-level check).
DO $$ DECLARE v_function regprocedure; BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.create_auction_draft(uuid,text,integer,text,integer,integer,boolean)'::regprocedure,
    'public.update_auction_draft(uuid,uuid,text,integer,text,integer,integer,boolean,boolean)'::regprocedure,
    'public.add_auction_draft_item(uuid,uuid,uuid,integer)'::regprocedure,
    'public.remove_auction_draft_item(uuid,uuid,uuid)'::regprocedure,
    'public.update_auction_draft_item(uuid,uuid,uuid,integer)'::regprocedure,
    'public.publish_auction(uuid,uuid)'::regprocedure,
    'public.place_auction_bid(uuid,uuid,integer)'::regprocedure,
    'public.checkout_auction_buyout(uuid,uuid,uuid,uuid)'::regprocedure,
    'public.checkout_auction_claim(uuid,uuid,uuid,uuid)'::regprocedure,
    'public.phase45c_auction_checkout_fingerprint(text,uuid,uuid,uuid)'::regprocedure,
    'public.extend_auction(uuid,uuid,integer,text)'::regprocedure,
    'public.relist_auction(uuid,uuid,integer)'::regprocedure,
    'public.settle_expired_auctions(integer,timestamptz)'::regprocedure,
    'public.transition_order(uuid,uuid,text,text)'::regprocedure,
    'public.phase45_allocate_auction_lines(uuid,integer)'::regprocedure
  ] LOOP
    IF has_function_privilege('authenticated',v_function,'EXECUTE') OR has_function_privilege('anon',v_function,'EXECUTE') OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
      RAISE EXCEPTION 'incorrect service-role grant on %',v_function;
    END IF;
  END LOOP;
END $$;

ROLLBACK;
