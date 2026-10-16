BEGIN;

-- Rollout: Dan applies this migration in the SQL editor BEFORE deploying the
-- batch route/client together. The route now requires this new RPC. Hosted DB
-- changes are not performed by agents. Receipts may be pruned after 30 days by
-- a separately reviewed future job; no expiry is enforced in this migration.
CREATE TABLE public.library_batch_receipts (
  user_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  binder_id uuid NOT NULL,
  rows_sha256 text NOT NULL CHECK (length(rows_sha256) = 64),
  inserted int NOT NULL CHECK (inserted >= 0),
  merged int NOT NULL CHECK (merged >= 0),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, batch_id)
);
ALTER TABLE public.library_batch_receipts ENABLE ROW LEVEL SECURITY;
-- No policies: receipts are service-role only, never browser-accessible.
REVOKE ALL ON TABLE public.library_batch_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.library_batch_receipts TO service_role;

CREATE FUNCTION public.import_library_cards_once(
  p_user_id uuid, p_binder_id uuid, p_batch_id uuid, p_rows jsonb
) RETURNS TABLE (inserted int, merged int, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claimed int;
  v_inserted int;
  v_merged int;
  v_binder_id uuid;
  v_rows_sha256 text;
BEGIN
  IF p_batch_id IS NULL OR p_batch_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_BATCH_ID' USING ERRCODE = '22023';
  END IF;
  -- Caller identity is supplied only by the authenticated service route. Keep
  -- the destination ownership check inside the privileged write boundary too.
  IF NOT EXISTS (SELECT 1 FROM public.binders WHERE id=p_binder_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'BINDER_NOT_OWNED' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)=0 THEN
    RAISE EXCEPTION 'INVALID_BATCH_ROWS' USING ERRCODE = '22023';
  END IF;

  -- A duplicate INSERT waits on the PK's transaction, so another request cannot
  -- observe the placeholder counts. The receipt and all inventory writes commit
  -- or roll back together; a failed import leaves the key retryable.
  INSERT INTO public.library_batch_receipts(user_id,batch_id,binder_id,rows_sha256,inserted,merged)
  VALUES(p_user_id,p_batch_id,p_binder_id,encode(sha256(convert_to(p_rows::text,'UTF8')),'hex'),0,0)
  ON CONFLICT ON CONSTRAINT library_batch_receipts_pkey DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT r.inserted,r.merged,r.binder_id,r.rows_sha256 INTO STRICT v_inserted,v_merged,v_binder_id,v_rows_sha256
    FROM public.library_batch_receipts r WHERE r.user_id=p_user_id AND r.batch_id=p_batch_id;
    IF v_binder_id <> p_binder_id OR v_rows_sha256 IS DISTINCT FROM encode(sha256(convert_to(p_rows::text,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'BATCH_ID_REUSED' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_inserted,v_merged,true;
    RETURN;
  END IF;

  SELECT i.inserted,i.merged INTO STRICT v_inserted,v_merged
  FROM public.import_library_cards(p_user_id,p_binder_id,p_rows) i;
  UPDATE public.library_batch_receipts r SET inserted=v_inserted,merged=v_merged
  WHERE r.user_id=p_user_id AND r.batch_id=p_batch_id;
  RETURN QUERY SELECT v_inserted,v_merged,false;
END;
$$;
REVOKE ALL ON FUNCTION public.import_library_cards_once(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_library_cards_once(uuid,uuid,uuid,jsonb) TO service_role;

COMMIT;
