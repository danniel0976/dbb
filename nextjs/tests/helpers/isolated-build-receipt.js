const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const RECEIPT_NAME = '.phase45c-isolated-build-receipt.json'

function fail(message) {
  throw new Error(`isolated candidate receipt refused: ${message}`)
}

function directory(value, label) {
  if (!value || !path.isAbsolute(value)) fail(`${label} must be an absolute path`)
  let real
  try { real = fs.realpathSync(value) } catch { fail(`${label} does not exist`) }
  if (!fs.statSync(real).isDirectory()) fail(`${label} is not a directory`)
  return real
}

function hash(file, label) {
  if (!fs.existsSync(file)) fail(`${label} is missing`)
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function nested(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function readReceipt(receiptPath) {
  if (!receiptPath || !path.isAbsolute(receiptPath)) fail('PHASE45C_ISOLATED_BUILD_RECEIPT must be an absolute path')
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) } catch { fail('receipt is absent or not valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('receipt must be an object')
  return parsed
}

function assertIsolatedBuildReceipt({ cwd = process.cwd(), configRoot, port, backendOrigin, appOrigin,
  receiptPath = process.env.PHASE45C_ISOLATED_BUILD_RECEIPT } = {}) {
  const receipt = readReceipt(receiptPath)
  if (receipt.version !== 1) fail('receipt version is unsupported')
  const candidateRoot = directory(receipt.candidateRoot, 'receipt candidateRoot')
  const sourceRoot = directory(receipt.sourceRoot, 'receipt sourceRoot')
  const actualCwd = directory(cwd, 'process cwd')
  const actualConfigRoot = directory(configRoot, 'config root')
  if (candidateRoot !== actualCwd || candidateRoot !== actualConfigRoot) {
    fail('receipt candidateRoot must equal both process cwd and config root')
  }
  if (nested(candidateRoot, sourceRoot) || nested(sourceRoot, candidateRoot)) {
    fail('receipt sourceRoot and candidateRoot must be separate, non-nested directories')
  }
  for (const [root, label] of [[candidateRoot, 'candidate'], [sourceRoot, 'source']]) {
    if (!fs.existsSync(path.join(root, 'package.json'))) fail(`${label} is not a package root`)
  }
  if (receipt.port !== String(port)) fail('receipt port does not match PW_PORT')
  if (receipt.backendOrigin !== backendOrigin) fail('receipt backend origin does not match harness backend')
  if (receipt.appOrigin !== appOrigin) fail('receipt app origin does not match isolated app origin')
  if (Number(port) === 3000) fail('receipt names protected port 3000')
  const sourceHash = hash(path.join(sourceRoot, '.next', 'BUILD_ID'), 'source .next/BUILD_ID')
  const candidateHash = hash(path.join(candidateRoot, '.next', 'BUILD_ID'), 'candidate .next/BUILD_ID')
  if (receipt.sourceBuildIdHashBefore !== sourceHash || receipt.sourceBuildIdHashAfter !== sourceHash) {
    fail('protected source BUILD_ID hash does not match the receipt')
  }
  if (receipt.candidateBuildIdHash !== candidateHash) fail('candidate BUILD_ID hash does not match the receipt')
  return { receiptPath, candidateRoot, sourceRoot }
}

module.exports = { RECEIPT_NAME, assertIsolatedBuildReceipt }
