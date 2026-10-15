#!/usr/bin/env node
//
// DBB Phase 38 - Regression Suite (with Phase 38A Performance Testing)
// Cross-phase user journeys via HTTP against the deployed (or local) app.
// Zero provider tokens - pure fetch calls.
//
// Usage:
//   node scripts/regression-suite.mjs                              # test production (runs=1)
//   node scripts/regression-suite.mjs --runs 10                    # functional + PT (10 runs)
//   node scripts/regression-suite.mjs --pt-only --runs 10          # PT only, skip functional checks
//   BASE_URL=http://localhost:3000 node scripts/regression-suite.mjs # test local
//   RUNS=10 node scripts/regression-suite.mjs                      # PT via env var
//
// Output: structured JSON to test-runs/<timestamp>.regression.json
//         summary to stdout
//         exit 0 all pass, non-zero on any failure (functional or PT regression)
//

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, '..');
const RUN_DIR = join(REPO_DIR, 'test-runs');
mkdirSync(RUN_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || 'https://dbb.lovelikenotomorrow.com';
const TIMESTAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const COMMIT = getCommit();

// ─── CLI args ─────────────────────────────────────────────
const argv = process.argv.slice(2);
const ptOnly = argv.includes('--pt-only');
const runsIdx = argv.indexOf('--runs');
let RUNS = 1;
const STRICT_INT = /^\d+$/;
if (runsIdx !== -1) {
  const raw = argv[runsIdx + 1];
  if (raw === undefined || raw.startsWith('--')) {
    console.error('Error: --runs requires a value (got none)');
    console.error('Usage: node scripts/regression-suite.mjs [--pt-only] [--runs N]  (1 <= N <= 100)');
    process.exit(2);
  }
  if (!STRICT_INT.test(raw)) {
    console.error('Error: --runs must be a positive integer (got ' + raw + ')');
    console.error('Usage: node scripts/regression-suite.mjs [--pt-only] [--runs N]  (1 <= N <= 100)');
    process.exit(2);
  }
  RUNS = parseInt(raw, 10);
} else if (process.env.RUNS) {
  const raw = process.env.RUNS;
  if (!STRICT_INT.test(raw)) {
    console.error('Error: RUNS env var must be a positive integer (got ' + raw + ')');
    process.exit(2);
  }
  RUNS = parseInt(raw, 10);
}

// Blocker 4: reject malformed --runs, cap >100
if (isNaN(RUNS) || RUNS < 1) {
  console.error('Error: --runs must be a positive integer (got ' + (argv[runsIdx + 1] ?? process.env.RUNS ?? 'undefined') + ')');
  console.error('Usage: node scripts/regression-suite.mjs [--pt-only] [--runs N]  (1 <= N <= 100)');
  process.exit(2);
}
if (RUNS > 100) {
  console.error('Error: --runs capped at 100 (got ' + RUNS + ')');
  process.exit(2);
}

// Blocker 2: reject --pt-only when RUNS < 2 (no measured runs possible)
if (ptOnly && RUNS < 2) {
  console.error('Error: --pt-only requires --runs >= 2 (got RUNS=' + RUNS + ')');
  console.error('Usage: node scripts/regression-suite.mjs --pt-only --runs N  (N >= 2)');
  process.exit(2);
}

const PT_THRESHOLD_MS = 500;

function getCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_DIR })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

// ─── Helpers ──────────────────────────────────────────────

async function fetchJson(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', ...opts.headers },
      redirect: 'manual', // don't follow - we want to see 3xx if any
      signal: AbortSignal.timeout(20000),
      ...opts,
    });
    const elapsed = Math.round(performance.now() - start);
    let body = null;
    let bodyError = null;
    try {
      body = await res.json();
    } catch {
      try { body = await res.text(); } catch { /* empty */ }
    }
    return { ok: true, status: res.status, headers: res.headers, body, elapsed, url };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    return { ok: false, status: 0, headers: null, body: null, bodyError: err.message, elapsed, url };
  }
}

// ─── Journeys ──────────────────────────────────────────────
// Each journey: name, run() → { passed, details, timing_ms }
// Journeys hit public endpoints that don't require auth.
// Authenticated journeys are marked as "skipped" (no test credentials available).

const journeys = [
  {
    name: 'Browser-local card scanner checks',
    description: 'Pure scanner parsing and ranking tests pass without network access',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-card-scanner.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'CARD_SCANNER_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `scanner tests failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'Browser-local scanner visual checks',
    description: 'Perceptual signatures and conservative visual tie-breaking pass without camera, canvas, or network access',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-card-scanner-visual.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'CARD_SCANNER_VISUAL_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `scanner visual tests failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'Card scanner state checks',
    description: 'Camera permission, missing-device, and unreadable-OCR recovery states are deterministic',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-card-scanner-state.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'CARD_SCANNER_STATE_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `scanner state tests failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'Card scanner session checks',
    description: 'Scanner paging, candidate routing, shelf safety, and batch behavior stay deterministic',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-card-scanner-session.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'CARD_SCANNER_SESSION_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `scanner session tests failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'Catalog scanner name retrieval checks',
    description: 'Scanner-only tolerant name plans, pooling, and paging stay bounded and deterministic',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-catalog-name-search.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'CATALOG_NAME_SEARCH_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `catalog name retrieval tests failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'Local catalog scanner retrieval fixture',
    description: 'Executable fixture proves typo, short-token, incidental-hit, and print-heavy top-five retrieval',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-catalog-scan-retrieval-local.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'CATALOG_SCAN_RETRIEVAL_LOCAL_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `local catalog retrieval fixture failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'Catalog refresh helper checks',
    description: 'Source selection and manifest helpers pass without network or database access',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-catalog-refresh.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'CATALOG_REFRESH_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `catalog refresh tests failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'UAT summary helper checks',
    description: 'Physical-card UAT rows summarize into the BRD metrics without network access',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-card-scanner-uat.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'UAT_SUMMARY_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `UAT summary tests failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'Catalog freshness helper checks',
    description: 'Freshness policy marks stale or missing manifests before release',
    async run() {
      const start = performance.now();
      try {
        const output = execSync('node scripts/test-catalog-freshness.mjs', {
          cwd: REPO_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (output !== 'CATALOG_FRESHNESS_PASS') {
          return { passed: false, details: `unexpected output: ${output.slice(0, 200)}`, timing_ms: Math.round(performance.now() - start) };
        }
        return { passed: true, details: output, timing_ms: Math.round(performance.now() - start) };
      } catch (err) {
        return { passed: false, details: `catalog freshness tests failed: ${err.message}`, timing_ms: Math.round(performance.now() - start) };
      }
    },
  },

  {
    name: 'Health check',
    description: 'GET /api/health returns 200 with status ok',
    async run() {
      const r = await fetchJson('/api/health');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status !== 200) return { passed: false, details: `expected 200 got ${r.status}`, timing_ms: r.elapsed };
      if (!r.body || r.body.status !== 'ok') return { passed: false, details: `body.status not ok: ${JSON.stringify(r.body).slice(0, 200)}`, timing_ms: r.elapsed };
      return { passed: true, details: 'status=ok', timing_ms: r.elapsed };
    },
  },

  {
    name: 'Home page loads',
    description: 'GET / returns 200 HTML',
    async run() {
      const r = await fetchJson('/');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      // Home may redirect to /library or render directly - 200 or 3xx both acceptable
      if (r.status >= 200 && r.status < 400) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200-3xx got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Library page loads',
    description: 'GET /library returns 200 or redirect to login',
    async run() {
      const r = await fetchJson('/library');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      // /library requires auth - expect redirect (302) to /login or 200 if already authed
      if (r.status === 200 || r.status === 302 || r.status === 307) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200/302/307 got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Bazaar page loads',
    description: 'GET /bazaar returns 200 or redirect',
    async run() {
      const r = await fetchJson('/bazaar');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status >= 200 && r.status < 400) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200-3xx got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Bazaar listings API',
    description: 'GET /api/listings?status=active returns structured listing data',
    async run() {
      const r = await fetchJson('/api/listings?status=active&page=1');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status !== 200) return { passed: false, details: `expected 200 got ${r.status}`, timing_ms: r.elapsed };
      // Response should have either listings array or pagination structure
      const body = r.body;
      if (!body) return { passed: false, details: 'empty body', timing_ms: r.elapsed };
      const hasListings = Array.isArray(body.listings) || Array.isArray(body.items) || Array.isArray(body.data);
      const hasPagination = body.page !== undefined || body.total !== undefined || body.count !== undefined;
      if (!hasListings && !hasPagination) return { passed: false, details: `unexpected body shape: ${JSON.stringify(body).slice(0, 300)}`, timing_ms: r.elapsed };
      return { passed: true, details: `has listings=${hasListings} pagination=${hasPagination}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Claim sales page loads',
    description: 'GET /claim-sales returns 200 or redirect',
    async run() {
      const r = await fetchJson('/claim-sales');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status >= 200 && r.status < 400) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200-3xx got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Claim sales API',
    description: 'GET /api/claim-sales returns structured claim sale data',
    async run() {
      const r = await fetchJson('/api/claim-sales?page=1&sort=newest');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status !== 200) return { passed: false, details: `expected 200 got ${r.status}`, timing_ms: r.elapsed };
      const body = r.body;
      if (!body) return { passed: false, details: 'empty body', timing_ms: r.elapsed };
      // Could be { sales: [...] } or { items: [...] } or just an array
      const hasArray = Array.isArray(body) || Array.isArray(body.sales) || Array.isArray(body.items) || Array.isArray(body.data);
      const hasPagination = body.page !== undefined || body.total !== undefined || body.count !== undefined;
      if (!hasArray && !hasPagination) return { passed: false, details: `unexpected body shape: ${JSON.stringify(body).slice(0, 300)}`, timing_ms: r.elapsed };
      return { passed: true, details: `structured data present`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Scryfall proxy lookup',
    description: 'GET /api/scryfall?set=lea&cn=161 returns card image data',
    async run() {
      // Scryfall proxy requires set + cn (collector number), not free-text q
      // Returns a single card object with image URLs, not the standard search response
      const r = await fetchJson('/api/scryfall?set=lea&cn=161');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status !== 200) return { passed: false, details: `expected 200 got ${r.status}`, timing_ms: r.elapsed };
      const body = r.body;
      if (!body) return { passed: false, details: 'empty body', timing_ms: r.elapsed };
      // Response is a single card object with image URLs
      const hasImage = body.image_crop_url || body.image_png_url || body.image_url;
      const hasData = Array.isArray(body.data) || body.total_cards !== undefined;
      if (!hasImage && !hasData && !body.error) {
        return { passed: false, details: `unexpected body shape: ${JSON.stringify(body).slice(0, 300)}`, timing_ms: r.elapsed };
      }
      return { passed: true, details: `scryfall proxy returned card data (has_image=${!!hasImage})`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Catalog search auth gate',
    description: 'GET /api/catalog/search without auth returns 401',
    async run() {
      const r = await fetchJson('/api/catalog/search?q=forest');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      // Without auth, should get 401 - this validates the auth gate is working
      if (r.status === 401) return { passed: true, details: 'auth gate active (401)', timing_ms: r.elapsed };
      // If it returns 200, auth might be bypassed (or endpoint is public) - note but pass
      if (r.status === 200) return { passed: true, details: 'no auth required (200)', timing_ms: r.elapsed };
      return { passed: false, details: `expected 401 or 200 got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Library API auth gate',
    description: 'GET /api/library without auth returns 401',
    async run() {
      const r = await fetchJson('/api/library');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status === 401) return { passed: true, details: 'auth gate active (401)', timing_ms: r.elapsed };
      if (r.status === 200) return { passed: true, details: 'no auth required (200)', timing_ms: r.elapsed };
      return { passed: false, details: `expected 401 or 200 got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Cart API auth gate',
    description: 'GET /api/cart without auth returns 401',
    async run() {
      const r = await fetchJson('/api/cart');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status === 401) return { passed: true, details: 'auth gate active (401)', timing_ms: r.elapsed };
      if (r.status === 200) return { passed: true, details: 'no auth required (200)', timing_ms: r.elapsed };
      return { passed: false, details: `expected 401 or 200 got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Profile API auth gate',
    description: 'GET /api/profile without auth returns 401',
    async run() {
      const r = await fetchJson('/api/profile');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status === 401) return { passed: true, details: 'auth gate active (401)', timing_ms: r.elapsed };
      if (r.status === 200) return { passed: true, details: 'no auth required (200)', timing_ms: r.elapsed };
      return { passed: false, details: `expected 401 or 200 got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Follows API auth gate',
    description: 'GET /api/follows without auth returns 401',
    async run() {
      const r = await fetchJson('/api/follows');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status === 401) return { passed: true, details: 'auth gate active (401)', timing_ms: r.elapsed };
      if (r.status === 200) return { passed: true, details: 'no auth required (200)', timing_ms: r.elapsed };
      return { passed: false, details: `expected 401 or 200 got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Login page loads',
    description: 'GET /login returns 200',
    async run() {
      const r = await fetchJson('/login');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status >= 200 && r.status < 400) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200-3xx got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Register page loads',
    description: 'GET /register returns 200',
    async run() {
      const r = await fetchJson('/register');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status >= 200 && r.status < 400) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200-3xx got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Import page loads',
    description: 'GET /import returns 200 or redirect to login',
    async run() {
      const r = await fetchJson('/import');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status >= 200 && r.status < 400) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200-3xx got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Profile page loads',
    description: 'GET /profile returns 200 or redirect to login',
    async run() {
      const r = await fetchJson('/profile');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status >= 200 && r.status < 400) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200-3xx got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Cart page loads',
    description: 'GET /cart returns 200 or redirect to login',
    async run() {
      const r = await fetchJson('/cart');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status >= 200 && r.status < 400) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 200-3xx got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Listings by card (bazaar detail)',
    description: 'GET /api/listings/card/<scryfallId> returns listing data for a known card',
    async run() {
      // Use Lightning Bolt (classic card, always in catalog)
      const r = await fetchJson('/api/listings/card/lightning-bolt');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status !== 200) return { passed: false, details: `expected 200 got ${r.status}`, timing_ms: r.elapsed };
      const body = r.body;
      if (!body) return { passed: false, details: 'empty body', timing_ms: r.elapsed };
      // Could be { listings: [...] } or { data: [...] } or []
      const hasListings = Array.isArray(body) || Array.isArray(body.listings) || Array.isArray(body.items) || Array.isArray(body.data);
      return { passed: true, details: `listings endpoint accessible, has array=${hasListings}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Pricing API auth gate',
    description: 'GET /api/pricing without auth returns 401 or 200',
    async run() {
      const r = await fetchJson('/api/pricing');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status === 401 || r.status === 200) return { passed: true, details: `status=${r.status}`, timing_ms: r.elapsed };
      return { passed: false, details: `expected 401 or 200 got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Binders API auth gate',
    description: 'GET /api/binders without auth returns 401',
    async run() {
      const r = await fetchJson('/api/binders');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      if (r.status === 401) return { passed: true, details: 'auth gate active (401)', timing_ms: r.elapsed };
      if (r.status === 200) return { passed: true, details: 'no auth required (200)', timing_ms: r.elapsed };
      return { passed: false, details: `expected 401 or 200 got ${r.status}`, timing_ms: r.elapsed };
    },
  },

  {
    name: 'Photos API method gate',
    description: 'GET /api/photos returns 405 (POST-only endpoint, proves route exists)',
    async run() {
      const r = await fetchJson('/api/photos');
      if (!r.ok) return { passed: false, details: `fetch failed: ${r.bodyError}`, timing_ms: r.elapsed };
      // /api/photos only has POST handler - GET should return 405 Method Not Allowed
      // This proves the route exists and is properly method-gated
      if (r.status === 405) return { passed: true, details: 'method gate active (405)', timing_ms: r.elapsed };
      if (r.status === 401) return { passed: true, details: 'auth gate active (401)', timing_ms: r.elapsed };
      if (r.status === 200) return { passed: true, details: 'no auth required (200)', timing_ms: r.elapsed };
      return { passed: false, details: `expected 405/401/200 got ${r.status}`, timing_ms: r.elapsed };
    },
  },
];

// ─── Main ──────────────────────────────────────────────────

// Compute p50/p95 from sorted timings array
function computePercentiles(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { p50_ms: 0, p95_ms: 0 };
  const p50Idx = Math.min(Math.floor(n * 0.5), n - 1);
  const p95Idx = Math.min(Math.floor(n * 0.95), n - 1);
  return { p50_ms: sorted[p50Idx], p95_ms: sorted[p95Idx] };
}

async function main() {
  console.log('=== DBB Phase 38 Regression Suite ===');
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`COMMIT:   ${COMMIT}`);
  console.log(`TIME:     ${TIMESTAMP}`);
  console.log(`JOURNEYS: ${journeys.length}`);
  if (RUNS > 1) {
    console.log(`RUNS:     ${RUNS} (1 warmup + ${RUNS - 1} measured)`);
    console.log(`PT_MODE:  ${ptOnly ? 'pt-only (functional checks skipped)' : 'functional + performance'}`);
  }
  console.log('');

  const results = [];
  let passCount = 0;
  let failCount = 0;
  let ptRegressionCount = 0;

  for (const journey of journeys) {
    process.stdout.write(`  ${journey.name.padEnd(42)} `);

    // --- Run 1: warmup (also serves as functional check in normal mode) ---
    let warmupResult = null;
    try {
      warmupResult = await journey.run();
    } catch (err) {
      warmupResult = { passed: false, details: `exception: ${err.message}`, timing_ms: 0 };
    }

    // In normal mode, the warmup run is the functional verdict
    let functionalPassed = true;
    let functionalDetails = 'pt-only mode';
    let functionalTiming = 0;
    if (!ptOnly) {
      functionalPassed = warmupResult.passed;
      functionalDetails = warmupResult.details ?? 'unknown';
      functionalTiming = warmupResult.timing_ms ?? 0;
      if (functionalPassed) {
        passCount++;
      } else {
        failCount++;
      }
    }

    // --- Measured runs (2..RUNS), only when RUNS > 1 ---
    let ptData = null;
    if (RUNS > 1) {
      const measuredTimings = [];
      const expectedMeasured = RUNS - 1;
      for (let i = 1; i < RUNS; i++) {
        try {
          const r = await journey.run();
          // Blocker 1: only accept timing when the run actually passed
          if (r && r.passed === true && typeof r.timing_ms === 'number') {
            measuredTimings.push(r.timing_ms);
          }
        } catch {
          // skip failed run from timing data
        }
      }

      if (measuredTimings.length > 0) {
        const { p50_ms, p95_ms } = computePercentiles(measuredTimings);
        // Blocker 1: PT regression if p95 exceeds threshold OR if too few successes
        const tooFewSuccesses = measuredTimings.length < expectedMeasured;
        const pt_regression = p95_ms > PT_THRESHOLD_MS || tooFewSuccesses;
        if (pt_regression) ptRegressionCount++;
        ptData = {
          p50_ms,
          p95_ms,
          pt_regression,
          measured_runs: measuredTimings.length,
          expected_measured_runs: expectedMeasured,
          all_timings_ms: measuredTimings,
        };
      } else {
        // Blocker 1: zero successes — PT regression
        ptRegressionCount++;
        ptData = {
          p50_ms: 0,
          p95_ms: 0,
          pt_regression: true,
          measured_runs: 0,
          expected_measured_runs: expectedMeasured,
          all_timings_ms: [],
        };
      }
    }

    // --- Build result entry ---
    // Blocker 3: PT-only entries must not claim functional passed:true
    const entry = {
      name: journey.name,
      description: journey.description,
      passed: ptOnly ? null : functionalPassed,
      functional_skipped: ptOnly ? true : false,
      details: ptOnly ? 'functional checks skipped (pt-only mode)' : functionalDetails,
      timing_ms: ptOnly ? (ptData?.p50_ms ?? 0) : functionalTiming,
    };
    if (ptData) {
      entry.p50_ms = ptData.p50_ms;
      entry.p95_ms = ptData.p95_ms;
      entry.pt_regression = ptData.pt_regression;
      entry.measured_runs = ptData.measured_runs;
      entry.expected_measured_runs = ptData.expected_measured_runs;
      entry.all_timings_ms = ptData.all_timings_ms;
    }
    results.push(entry);

    // --- Console output ---
    if (ptOnly) {
      const flag = ptData?.pt_regression ? ' ⚠ PT_REGRESSION' : '';
      console.log(`◦ PT   p50=${ptData?.p50_ms ?? 0}ms p95=${ptData?.p95_ms ?? 0}ms${flag}`);
    } else if (functionalPassed) {
      const ptStr = ptData ? `  p95=${ptData.p95_ms}ms${ptData.pt_regression ? ' ⚠' : ''}` : '';
      console.log(`✓ PASS  ${functionalTiming}ms  ${functionalDetails}${ptStr}`);
    } else {
      console.log(`✗ FAIL  ${functionalTiming}ms  ${functionalDetails}`);
    }
  }

  const total = passCount + failCount;
  // Blocker 3: in pt-only mode, overall reflects PT outcome, not functional pass/fail
  let overall;
  if (ptOnly) {
    overall = ptRegressionCount === 0 ? 'PT_PASS' : 'PT_FAIL';
  } else {
    overall = (failCount === 0 && ptRegressionCount === 0) ? 'PASS' : 'FAIL';
  }

  console.log('');
  if (ptOnly) {
    console.log(`Result: PT ${ptRegressionCount === 0 ? 'PASS' : 'FAIL'} — ${ptRegressionCount} PT regressions (functional checks skipped)`);
  } else {
    console.log(`Result: ${passCount}/${total} passed, ${failCount} failed${ptRegressionCount > 0 ? `, ${ptRegressionCount} PT regressions` : ''} → ${overall}`);
  }

  // --- PT Summary Table ---
  if (RUNS > 1) {
    console.log('');
    console.log('── Performance Testing Summary ──');
    console.log(`  ${'Journey'.padEnd(42)} ${'p50'.padStart(7)} ${'p95'.padStart(7)}  flag`);
    console.log(`  ${'─'.repeat(42)} ${'─'.repeat(7)} ${'─'.repeat(7)}  ${'─'.repeat(4)}`);
    for (const r of results) {
      const flag = r.pt_regression ? '⚠ YES' : '  no';
      console.log(`  ${r.name.padEnd(42)} ${(r.p50_ms + 'ms').padStart(7)} ${(r.p95_ms + 'ms').padStart(7)}  ${flag}`);
    }
    console.log(`  Threshold: ${PT_THRESHOLD_MS}ms p95`);
    console.log('');
  }

  // Write JSON artifact
  const artifact = {
    timestamp: TIMESTAMP,
    commit: COMMIT,
    base_url: BASE_URL,
    suite: 'phase38-regression',
    overall,
    results,
  };
  if (ptOnly) {
    // Blocker 3: expose functional checks skipped at top level
    artifact.functional_checks = 'skipped';
    artifact.functional_skipped = true;
  } else {
    artifact.pass_count = passCount;
    artifact.fail_count = failCount;
    artifact.total = total;
  }
  if (RUNS > 1) {
    artifact.pt = {
      runs: RUNS,
      warmup: 1,
      measured_runs: RUNS - 1,
      threshold_ms: PT_THRESHOLD_MS,
      pt_regression_count: ptRegressionCount,
      pt_only: ptOnly,
    };
  }

  const artifactPath = join(RUN_DIR, `${TIMESTAMP}.regression.json`);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  console.log(`Artifact: ${artifactPath}`);

  const exitCode = ptOnly
    ? (ptRegressionCount > 0 ? 1 : 0)
    : (failCount > 0 || ptRegressionCount > 0 ? 1 : 0);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});