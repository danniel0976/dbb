# test-runs/

Structured test artifacts from `scripts/deploy-smoke.sh`.

Each run writes `<timestamp>.smoke.json` with:
- `timestamp` — UTC ISO-ish run time
- `commit` — git short hash at run time
- `base_url` — target URL
- `overall` — PASS or FAIL
- `pass_count` / `fail_count` / `total`
- `routes[]` — per-route: path, expected status, actual status, time_ms, verdict

## Location

This directory is in the **dbb repo** at `nextjs/test-runs/`. It is gitignored —
artifacts are local-only, not committed. Run artifacts accumulate here for
local comparison across deploys.

## Usage

```bash
# Run against production (default)
./scripts/deploy-smoke.sh

# Run against local dev
BASE_URL=http://localhost:3000 ./scripts/deploy-smoke.sh
```

On failure, a flag file is written to `/tmp/dbb-smoke-fail` for watchdog pickup.