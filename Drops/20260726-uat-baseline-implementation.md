# DBB local-UAT baseline implementation — 2026-07-26

## Status

Implemented the requested tracked local-UAT artifacts in one focused local
commit containing only the four artifacts listed below. The SQL is statically
inspected. The installed CLI accepted the tracked config far enough to derive
the `dbb-uat` local container name, then reported that the container is not
running. A database reset was not run by this worker, per the explicit
no-mutation boundary.

The canonical baseline filename is `20260101000000_dbb_baseline.sql`, which
sorts before the existing Phase 39–45B migrations. The CLI can therefore apply
the dependency chain in order; the reset itself remains untried because the
local `dbb-uat` container is not running. Existing files were not modified.

## Files changed

- `supabase/config.toml` — stable `project_id = "dbb-uat"`, local-only ports,
  auth, storage, seed, and migration settings.
- `supabase/migrations/20260101000000_dbb_baseline.sql` — self-contained squash
  in dependency order.
- `supabase/seed.sql` — deterministic synthetic fixed account and minimal
  card/library/photo fixture.
- `Drops/20260726-uat-baseline-implementation.md` — this report.

No existing file was modified. No production, Docker, env, OpenClaw, remote link,
or database state was touched.

## Source composition and order

The squash includes these sources, in this exact order:

1. `supabase/migration-002-multiuser.sql`
2. `supabase/migration-003-move-rpc.sql`
3. `supabase/migration-004-listings.sql`
4. `supabase/migration-005-indexes.sql`
5. `supabase/migration-006-cart.sql`
6. `supabase/migration-007-catalog.sql`
7. `supabase/migration-008-indexes.sql`
8. `supabase/migration-009-listing-lifecycle.sql`
9. `supabase/migration-010-card-photos.sql`
10. `supabase/migration-011-rpc-binder-validation.sql`
11. `supabase/migration-012-theme-preference.sql`
12. `supabase/migration-013-claim-sales.sql`
13. `supabase/migration-014-listing-quantity.sql`
14. `supabase/migration-015-card-hashes.sql`
15. `supabase/migrations/20260716000000_phase39_orders.sql`
16. `supabase/migrations/20260717010000_phase40_expand.sql`
17. `supabase/migrations/20260717011500_phase40_contract.sql`
18. `supabase/migrations/20260718000000_phase41_search_sort_hardening.sql`
19. `supabase/migrations/20260724000000_phase45_auctions_expand.sql`
20. `supabase/migrations/20260724000001_phase45_auctions_rpcs.sql`

The obsolete `supabase/schema.sql` was excluded. The obsolete
`supabase/migration-add-foil-pricing.sql` was excluded because it targets
`public.cards` and `calculate_myr_prices`, which are not part of the current
`public.card_index`/Phase 45 schema. Current application references to
`cards` are legacy code outside the Phase 45 schema and do not justify
introducing that obsolete table.

## Acceptance checks run

- Confirmed all three requested files exist.
- Confirmed installed CLI: `supabase 2.75.0`.
- Generated a disposable CLI config with the installed CLI and matched its
  supported sections/keys; ran `supabase status --workdir ...` read-only. The
  status probe could not inspect health because `supabase_db_dbb-uat` is not
  running; it did not mutate anything.
- Static SQL checks: source markers are present in order; baseline contains
  Phase 45 tables/RPCs; excluded files are absent from the new baseline; seed
  contains no hosted project ID, hosted URL, service key, or production row ID.
- Ran staged `git diff --check` before commit.
- Did not run `supabase db reset`, `supabase db start/stop`, SQL suites,
  authenticated REST tests, or any command that mutates database/Docker state.

## Failed/untried checks

- Full empty-database reset is untried because the local `dbb-uat` container is
  not running; canonical timestamp ordering is now resolved.
- SQL execution against PostgreSQL is untried; static inspection cannot prove
  auth.users column compatibility or all procedural SQL behavior.
- Seed login and Phase 45 SQL suites are untried.
- Independent verification is still required.

## Next command for Main

When the disposable local stack is available, run:

```sh
supabase db reset --workdir /Users/changrimbook/.openclaw/workspace/dbb-phase44-pass-a
```

Then assert the migration ledger, expected public tables/RPCs/RLS, and
`dan@dbb.test` login before running the three tracked Phase 45 SQL suites.
