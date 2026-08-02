-- Phase 45C contract: Claim Sale lifecycle mutations are service-only.
-- All current application writers already use the service-role client. Apply
-- this contract after that compatible route rollout; no authenticated app
-- version depends on direct claim_sales INSERT/UPDATE/DELETE.

DROP POLICY IF EXISTS "owner claim_sales crud" ON public.claim_sales;

CREATE POLICY "owner claim_sales select" ON public.claim_sales
  FOR SELECT USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.claim_sales FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.claim_sales TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_sales TO service_role;

COMMENT ON TABLE public.claim_sales IS
  'Bundle presentation parent. Lifecycle transitions require phase45c_* lifecycle functions; direct client DML is closed.';
