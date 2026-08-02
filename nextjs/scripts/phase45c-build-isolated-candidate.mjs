// Fail-closed builder for the mutating Phase 45C Claim Sale browser UAT.
//
// This file is deliberately run FROM a disposable candidate copy, not from the
// protected source worktree. A copy existing elsewhere is meaningless if the
// build command retains the source CWD: Next would overwrite source `.next`.
// The preflight therefore makes that operator error an immediate refusal before
// it starts `npm run build`, a server, Playwright, fixture seeding, or any DB IO.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptFile = fileURLToPath(import.meta.url)
const packageRoot = fs.realpathSync(path.resolve(path.dirname(scriptFile), '..'))

function fail(message) {
  throw new Error(`isolated candidate build refused: ${message}`)
}

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    fail(`${name} is required`)
  }
  return process.argv[index + 1]
}

function realDirectory(value, label) {
  const resolved = path.resolve(value)
  let real
  try {
    real = fs.realpathSync(resolved)
  } catch {
    fail(`${label} does not exist: ${resolved}`)
  }
  if (!fs.statSync(real).isDirectory()) fail(`${label} is not a directory: ${real}`)
  return real
}

function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function fileHash(file, label) {
  if (!fs.existsSync(file)) fail(`${label} is missing: ${file}`)
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function parseUrl(value, label) {
  try {
    return new URL(String(value || ''))
  } catch {
    fail(`${label} is not a URL`)
  }
}

function assertPublicOrigins(port) {
  const backend = parseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL')
  const app = parseUrl(process.env.NEXT_PUBLIC_SITE_URL, 'NEXT_PUBLIC_SITE_URL')
  const loopbackBackend = backend.protocol === 'http:'
    && (backend.hostname === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(backend.hostname))
  if (!loopbackBackend) fail('NEXT_PUBLIC_SUPABASE_URL must be an IPv4 loopback http origin')
  if (app.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(app.hostname)) {
    fail('NEXT_PUBLIC_SITE_URL must be an IPv4 loopback http origin')
  }
  if (Number(port) === 3000) fail('--port 3000 is the protected phone-facing service')
  if (app.port !== String(port)) fail(`NEXT_PUBLIC_SITE_URL port ${app.port || 'default'} must equal --port ${port}`)
  return { backend: backend.origin, app: app.origin }
}

const sourceRoot = realDirectory(option('--source'), '--source')
const candidateRoot = realDirectory(option('--candidate'), '--candidate')
const port = option('--port')
const verifyOnly = process.argv.includes('--verify-only')

if (!/^\d+$/.test(port)) fail(`--port ${port} is not numeric`)
const actualCwd = fs.realpathSync(process.cwd())
if (actualCwd !== candidateRoot) {
  fail(`current directory ${actualCwd} is not the declared candidate ${candidateRoot}`)
}
if (packageRoot !== candidateRoot) {
  fail(`this guard lives under ${packageRoot}, not the declared candidate ${candidateRoot}`)
}
if (isInside(candidateRoot, sourceRoot) || isInside(sourceRoot, candidateRoot)) {
  fail('candidate and source must be separate, non-nested directories')
}
for (const [root, label] of [[sourceRoot, 'source'], [candidateRoot, 'candidate']]) {
  if (!fs.existsSync(path.join(root, 'package.json'))) fail(`${label} is not a Next package root`)
}

const sourceBuildId = path.join(sourceRoot, '.next', 'BUILD_ID')
const sourceHashBefore = fileHash(sourceBuildId, 'source .next/BUILD_ID')
const origins = assertPublicOrigins(port)

if (verifyOnly) {
  console.log(JSON.stringify({ ok: true, mode: 'verify-only', sourceHashBefore, ...origins }))
  process.exit(0)
}

const build = spawnSync('npm', ['run', 'build'], {
  cwd: candidateRoot,
  stdio: 'inherit',
  env: process.env,
})
if (build.error) fail(`could not start candidate build: ${build.error.message}`)
if (build.status !== 0) process.exit(build.status || 1)

const sourceHashAfter = fileHash(sourceBuildId, 'source .next/BUILD_ID after candidate build')
if (sourceHashAfter !== sourceHashBefore) {
  fail('candidate build changed the protected source .next/BUILD_ID; do not start a server or test')
}
const candidateBuildId = path.join(candidateRoot, '.next', 'BUILD_ID')
const candidateBuildIdHash = fileHash(candidateBuildId, 'candidate .next/BUILD_ID')
const receiptPath = path.join(candidateRoot, '.phase45c-isolated-build-receipt.json')
const receipt = {
  version: 1,
  sourceRoot,
  candidateRoot,
  sourceBuildIdHashBefore: sourceHashBefore,
  sourceBuildIdHashAfter: sourceHashAfter,
  candidateBuildIdHash,
  backendOrigin: origins.backend,
  appOrigin: origins.app,
  port: String(port),
}
const pendingReceipt = `${receiptPath}.tmp-${process.pid}`
fs.writeFileSync(pendingReceipt, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
fs.renameSync(pendingReceipt, receiptPath)
console.log(JSON.stringify({ ok: true, mode: 'built', receiptPath, sourceHashBefore, sourceHashAfter, ...origins }))
