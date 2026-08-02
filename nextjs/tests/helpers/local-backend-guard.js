// Fail-closed admission guard for the Phase 45C rendered UAT.
//
// These browser tests mutate real rows (cart, checkout, orders). `.env.local`
// deliberately points NEXT_PUBLIC_SUPABASE_URL at the phone-facing Tailscale
// address, so a Next.js build made from it serves a client bundle wired to a
// non-loopback backend. A green `baseURL: http://localhost:3000` proves only
// that the *frontend* is local; the backend behind it is a separate question.
//
// So: before a single mutation, resolve the Supabase URL the candidate server
// actually serves and refuse to run unless it is loopback. Three independent
// mechanisms, all fail-closed:
//
//   0. Harness environment — the mutations that matter (cart add, checkout,
//      order transition) do not run in the browser at all. `/api/cart` and
//      `/api/checkout` build their Supabase clients *server-side* from
//      `process.env.NEXT_PUBLIC_SUPABASE_URL`, read at request time. Neither of
//      the two mechanisms below can see that traffic: the bundle scan reads the
//      URL inlined at *build* time, and the request guard only sees the
//      browser. A `.next` built against loopback served by a process started
//      from `.env.local` therefore passes both while every mutation lands on
//      the Tailscale backend. Playwright's `webServer` child inherits this
//      process's environment, so requiring the harness's own resolved
//      NEXT_PUBLIC_SUPABASE_URL to be the approved origin is what pins the
//      server side.
//   1. Bundle resolution — download the candidate's own /login page and the
//      scripts it references, and read back the URL that was inlined into
//      createClient(). Nothing found, or anything non-loopback found, aborts
//      the run before the first test action.
//   2. Request interception — every Supabase-shaped request the browser makes
//      is classified, and any that leaves loopback is aborted and recorded as
//      a violation. This catches a backend origin that never appeared in the
//      scanned chunks.
//   3. App-origin interception — the backend is not the only thing a build can
//      be wired to. `src/middleware.js` builds every auth redirect from
//      NEXT_PUBLIC_SITE_URL, and `.env.local` points that at the phone-facing
//      shared server. A candidate built without an explicit isolated site URL
//      therefore answers the very first protected navigation with a redirect
//      *off* the isolated app, carrying the fixture session cookies to another
//      application instance — a LAN dev server, a staging deployment, Dan's
//      long-lived 3000. Mechanisms 1 and 2 cannot see that: the origin is not
//      Supabase-shaped and the backend it reaches is the other app's business.
//      So every cross-origin http(s) request that targets an *application*
//      rather than a public asset is aborted and recorded too.
//
// Only the loopback forms are approved. A Tailscale CGNAT address (100.64/10)
// is rejected by name even though it may terminate on this same machine: the
// contract for these tests is loopback-only, and "it happens to be my own
// Tailscale IP" is exactly the reasoning that would let a remote host through.

const path = require('node:path')

// Load .env.local without clobbering anything the operator set explicitly, so
// SUPABASE_SERVICE_ROLE_KEY is available for fixture cleanup while an explicit
// loopback NEXT_PUBLIC_SUPABASE_URL on the command line still wins.
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.local'), override: false })

// The one backend these tests are allowed to touch. Overridable only to another
// loopback origin — validated below, not trusted.
const LOCAL_SUPABASE_URL = process.env.PW_LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321'

// Supabase's HTTP surface. A request to one of these paths is backend traffic
// no matter which host it is aimed at.
const BACKEND_PATH_PREFIXES = [
  '/auth/v1/', '/rest/v1/', '/storage/v1/', '/realtime/v1/', '/functions/v1/', '/pg/',
]

function stripBrackets(hostname) {
  return hostname.replace(/^\[/, '').replace(/\]$/, '')
}

function isLoopbackHost(hostname) {
  const host = stripBrackets(String(hostname || '')).toLowerCase()
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

// Tailscale's CGNAT range. Called out separately so the failure message names
// the actual hazard instead of a generic "not loopback".
function isTailscaleHost(hostname) {
  const match = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(stripBrackets(String(hostname || '')))
  if (!match) return false
  const second = Number(match[1])
  return second >= 64 && second <= 127
}

// Address space that can only be reached from inside this machine or this
// network: loopback, the Tailscale CGNAT range, the RFC1918 LAN blocks,
// link-local, the IPv6 ULA/link-local blocks, and the mDNS/MagicDNS suffixes
// and bare single-label names that resolve into them. Nothing here is a public
// CDN, so a cross-origin request to one of these is another *service* reachable
// from this machine — which, for this suite, means another app instance.
function isPrivateNetworkHost(hostname) {
  const host = stripBrackets(String(hostname || '')).toLowerCase()
  if (!host) return false
  if (isLoopbackHost(host) || isTailscaleHost(host)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true
  if (host.endsWith('.local') || host.endsWith('.ts.net')) return true
  // A single-label name has no public DNS meaning; it resolves through the
  // local resolver to something on this network.
  return !host.includes('.')
}

// Paths only this application serves. `/api/` is its own server-side surface and
// `/_next/` is its build output, so either one on a foreign origin is a second
// app instance being driven rather than an asset being fetched. `_rsc` is the
// query Next.js adds to a React Server Component prefetch of a route.
const APP_PATH_PREFIXES = ['/api/', '/_next/']

function parseUrl(value) {
  try {
    return new URL(String(value))
  } catch {
    return null
  }
}

// Does this URL address an application rather than a third-party resource?
//
// A navigation always counts. Where the tab goes is where the fixture session
// cookies go, and this suite has no legitimate reason to leave its own origin —
// so a cross-origin navigation is a departure from the isolated app whatever
// sits at the other end. That is what catches a middleware redirect built from
// a non-isolated NEXT_PUBLIC_SITE_URL, which is the exact hazard: the host in
// it is a perfectly ordinary public name in the staging case, indistinguishable
// from a CDN by hostname alone.
//
// A sub-resource counts when it is app-shaped by path, is an RSC prefetch, or
// is aimed at an origin that cannot be a public CDN. Everything else — the
// Scryfall artwork the fixture cards point at, fonts, docs — is left alone.
function isApplicationRequest(url, { isNavigation = false } = {}) {
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false
  if (isNavigation) return true
  if (APP_PATH_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return true
  if (url.searchParams.has('_rsc')) return true
  return isPrivateNetworkHost(url.hostname)
}

// The loopback aliases the IPv4-only server command can actually answer on.
// `localhost` is the configured baseURL and 127.0.0.1 is the address the child
// binds. `[::1]` is deliberately absent: `-H 127.0.0.1` does not own an IPv6
// listener, so treating that origin as this app could admit another process.
// The port is still pinned, so this widens nothing beyond the server this run
// started.
const LOOPBACK_APP_HOSTNAMES = ['localhost', '127.0.0.1']

function isolatedAppOrigins(appOrigin) {
  const url = parseUrl(appOrigin)
  if (!url) return []
  // Do not seed this list with a caller-supplied origin. The caller tells us
  // the port this isolated run owns, but not which interface it owns: the
  // server command binds IPv4 127.0.0.1 only, so an untrusted [::1] base URL
  // must not become owned simply by being passed to this helper.
  if (url.protocol !== 'http:' || !LOOPBACK_APP_HOSTNAMES.includes(url.hostname)) return []
  const port = url.port ? `:${url.port}` : ''
  return LOOPBACK_APP_HOSTNAMES.map(host => `http://${host}${port}`)
}

function isApprovedLocalSupabaseUrl(value) {
  const url = parseUrl(value)
  if (!url) return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return isLoopbackHost(url.hostname)
}

function describeBackendRejection(value) {
  const url = parseUrl(value)
  if (!url) return `${value} is not a parseable URL`
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `${url.origin} uses protocol ${url.protocol}, expected http(s)`
  }
  if (isTailscaleHost(url.hostname)) {
    return `${url.origin} is a Tailscale (100.64/10) address; these tests are loopback-only`
  }
  return `${url.origin} is not a loopback backend`
}

function assertApprovedLocalSupabaseUrl(value, label) {
  if (!isApprovedLocalSupabaseUrl(value)) {
    throw new Error(`${label} refused: ${describeBackendRejection(value)}`)
  }
  return new URL(String(value)).origin
}

// The approved backend origin for this run, validated at module load so an
// override can never widen the allowlist.
const APPROVED_BACKEND_ORIGIN =
  assertApprovedLocalSupabaseUrl(LOCAL_SUPABASE_URL, 'PW_LOCAL_SUPABASE_URL')

// Pin the server side. `/api/cart` and `/api/checkout` resolve
// NEXT_PUBLIC_SUPABASE_URL from the server process at request time, so the only
// thing that decides where a checkout writes is the environment the Next.js
// process was started with. Playwright's `webServer` child inherits this
// process's environment, which is why asserting it here is a real gate and not
// bookkeeping: without the explicit override, `.env.local` (loaded at module
// load with override:false) supplies the phone-facing Tailscale URL and every
// server-side mutation leaves loopback while the browser-side checks stay green.
//
// Equality with the approved origin is required, not merely "some loopback
// URL": a server writing to loopback A while teardown asserts loopback B would
// report a restored fixture that was never restored.
function assertHarnessBackendEnv({ env = process.env } = {}) {
  const configured = env.NEXT_PUBLIC_SUPABASE_URL
  if (!configured) {
    throw new Error(
      'backend admission: NEXT_PUBLIC_SUPABASE_URL is unset in the test process, so the '
      + 'server-side backend used by /api/cart and /api/checkout is unidentified. Run with '
      + `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_BACKEND_ORIGIN}.`)
  }
  const parsedUrl = parseUrl(configured)
  if (!parsedUrl || parsedUrl.origin !== APPROVED_BACKEND_ORIGIN) {
    throw new Error(
      'backend admission: the test process resolves NEXT_PUBLIC_SUPABASE_URL to '
      + `${parsedUrl ? parsedUrl.origin : configured}, which the Next.js server inherits for its `
      + 'server-side cart/checkout writes — '
      + `${describeBackendRejection(configured)}. Re-run with `
      + `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_BACKEND_ORIGIN} so the mutating API routes are `
      + 'pinned to the approved backend.')
  }
  return parsedUrl.origin
}

// Next.js inlines NEXT_PUBLIC_* at build time, so the client bundle contains a
// literal createClient(<url>, <anon jwt>) pair. Matching the URL through its
// adjacent JWT argument is what keeps unrelated absolute URLs (image CDNs,
// docs links) out of the result.
const CREATE_CLIENT_CALL = /["'](https?:\/\/[^"'\s]+?)["']\s*,\s*["']eyJ[A-Za-z0-9_-]{4,}\./g

function extractSupabaseOriginsFromSource(source) {
  const origins = new Set()
  for (const [, rawUrl] of String(source || '').matchAll(CREATE_CLIENT_CALL)) {
    const url = parseUrl(rawUrl)
    if (url) origins.add(url.origin)
  }
  return [...origins]
}

const SCRIPT_SRC = /<script[^>]+src="([^"]+)"/g

function collectScriptUrls(html, baseURL) {
  const urls = new Set()
  for (const [, src] of String(html || '').matchAll(SCRIPT_SRC)) {
    const resolved = parseUrl(new URL(src, baseURL).href)
    if (resolved) urls.add(resolved.href)
  }
  return [...urls]
}

// Download what the candidate actually serves and read the backend origin back
// out of it. Anything other than "exactly the approved loopback origin, and
// nothing else" throws.
async function resolveCandidateBackendOrigins({ request, baseURL, probePath = '/login' }) {
  const pageResponse = await request.get(new URL(probePath, baseURL).href)
  if (!pageResponse.ok()) {
    throw new Error(
      `backend admission: candidate ${baseURL}${probePath} returned ${pageResponse.status()}`)
  }
  const html = await pageResponse.text()

  const origins = new Set(extractSupabaseOriginsFromSource(html))
  for (const scriptUrl of collectScriptUrls(html, baseURL)) {
    const scriptResponse = await request.get(scriptUrl)
    if (!scriptResponse.ok()) continue
    for (const origin of extractSupabaseOriginsFromSource(await scriptResponse.text())) {
      origins.add(origin)
    }
  }
  return [...origins]
}

async function assertCandidateBackendIsLocal({ request, baseURL }) {
  const origins = await resolveCandidateBackendOrigins({ request, baseURL })
  if (origins.length === 0) {
    throw new Error(
      `backend admission: could not resolve the Supabase URL served by ${baseURL}. `
      + 'Refusing to mutate against an unidentified backend. Rebuild and serve with '
      + `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_BACKEND_ORIGIN}.`)
  }
  const rejected = origins.filter(origin => !isApprovedLocalSupabaseUrl(origin))
  if (rejected.length > 0) {
    throw new Error(
      `backend admission: ${baseURL} is wired to ${rejected.join(', ')} — `
      + `${describeBackendRejection(rejected[0])}. Rebuild and serve with `
      + `NEXT_PUBLIC_SUPABASE_URL=${APPROVED_BACKEND_ORIGIN} before running rendered UAT.`)
  }
  return origins
}

// Confirm the approved backend is the one that is actually up, so a green run
// can never come from a stale server pointed somewhere else.
async function assertLocalBackendReachable({ request }) {
  const response = await request.get(`${APPROVED_BACKEND_ORIGIN}/auth/v1/health`)
  if (!response.ok()) {
    throw new Error(
      `backend admission: ${APPROVED_BACKEND_ORIGIN} health check returned ${response.status()}`)
  }
  return APPROVED_BACKEND_ORIGIN
}

// Classify a single browser request. Genuinely third-party traffic (the
// Scryfall image CDN the fixture cards point at, fonts, docs) is deliberately
// left alone; Supabase-shaped traffic and anything that addresses a *second
// application* are the two things policed.
//
// The order matters: a Supabase-shaped URL is judged as a backend first, so a
// Tailscale host keeps naming the backend hazard it already named. Only what
// is left over is tested for being another application.
function classifyRequest(requestUrl, { appOrigin, isNavigation = false } = {}) {
  const url = parseUrl(requestUrl)
  if (!url) return 'unknown'
  const appOrigins = isolatedAppOrigins(appOrigin)
  const isOwnApp = appOrigins.includes(url.origin)

  const looksLikeBackend =
    BACKEND_PATH_PREFIXES.some(prefix => url.pathname.startsWith(prefix))
    || url.port === '54321'
    || isTailscaleHost(url.hostname)

  if (looksLikeBackend) {
    if (isOwnApp) return 'app'
    return isApprovedLocalSupabaseUrl(url.origin) ? 'approved-backend' : 'blocked-backend'
  }
  if (isOwnApp) return 'app'
  if (isApplicationRequest(url, { isNavigation })) return 'blocked-app'
  return 'third-party'
}

// The verdicts that must never be allowed to proceed.
const BLOCKED_VERDICTS = ['blocked-backend', 'blocked-app']

// Runtime half of the guard: abort any Supabase-shaped request that leaves
// loopback, and any request that addresses an application other than the
// isolated one, and record both. Aborting rather than merely observing is what
// makes this fail-closed — a misdirected mutation never reaches a remote
// backend, and a redirect built from a foreign NEXT_PUBLIC_SITE_URL never
// carries the fixture session to another app.
async function installBackendOriginGuard(page, { baseURL } = {}) {
  const appOrigin = baseURL ? new URL(baseURL).origin : undefined
  if (!appOrigin || isolatedAppOrigins(appOrigin).length === 0) {
    throw new Error(
      'backend admission: installBackendOriginGuard needs an approved isolated IPv4 app origin '
      + '(baseURL) to tell this application apart from another one. Refusing to run unguarded.')
  }
  const state = { violations: [], appViolations: [], contacted: new Set() }

  await page.route('**/*', route => {
    const request = route.request()
    const requestUrl = request.url()
    const isNavigation = request.isNavigationRequest() || request.resourceType() === 'document'
    const verdict = classifyRequest(requestUrl, { appOrigin, isNavigation })
    if (BLOCKED_VERDICTS.includes(verdict)) {
      state.violations.push(requestUrl)
      if (verdict === 'blocked-app') state.appViolations.push(requestUrl)
      return route.abort('blockedbyclient')
    }
    if (verdict === 'approved-backend') state.contacted.add(new URL(requestUrl).origin)
    return route.continue()
  })

  state.assertNoViolations = () => {
    if (state.violations.length === 0) return
    const offApp = state.appViolations.length > 0
      ? ` ${state.appViolations.length} of them left the isolated app origin ${appOrigin} for `
        + `another application (${[...new Set(state.appViolations)].slice(0, 5).join(', ')}); a `
        + 'redirect built from a non-isolated NEXT_PUBLIC_SITE_URL is the usual cause, and '
        + 'NEXT_PUBLIC_* is inlined at build time, so the build has to be redone with it.'
      : ''
    throw new Error(
      `backend admission: ${state.violations.length} request(s) left the approved local backend `
      + `or the isolated app: ${[...new Set(state.violations)].slice(0, 5).join(', ')}.${offApp}`)
  }
  return state
}

module.exports = {
  APPROVED_BACKEND_ORIGIN,
  APP_PATH_PREFIXES,
  BACKEND_PATH_PREFIXES,
  BLOCKED_VERDICTS,
  LOOPBACK_APP_HOSTNAMES,
  assertApprovedLocalSupabaseUrl,
  assertCandidateBackendIsLocal,
  assertHarnessBackendEnv,
  assertLocalBackendReachable,
  classifyRequest,
  describeBackendRejection,
  extractSupabaseOriginsFromSource,
  installBackendOriginGuard,
  isApplicationRequest,
  isApprovedLocalSupabaseUrl,
  isLoopbackHost,
  isPrivateNetworkHost,
  isTailscaleHost,
  isolatedAppOrigins,
  resolveCandidateBackendOrigins,
}
