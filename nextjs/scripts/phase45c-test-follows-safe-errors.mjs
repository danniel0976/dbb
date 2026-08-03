#!/usr/bin/env node

// The Auction PR owns POST/DELETE follow mutations. Scan every JSON response
// construction after comments are stripped so database exception text cannot
// be reintroduced into a public response body.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url)
const ROUTE_PATH = new URL('nextjs/src/app/api/follows/route.js', ROOT)
const source = readFileSync(ROUTE_PATH, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

function responseBodies(code) {
  const bodies = []
  const needle = 'NextResponse.json('
  let start = code.indexOf(needle)
  while (start !== -1) {
    let depth = 0
    let quote = null
    let escaped = false
    let end = start + needle.length
    for (; end < code.length; end += 1) {
      const char = code[end]
      if (quote) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = null
        continue
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char
      } else if (char === '(') {
        depth += 1
      } else if (char === ')') {
        if (depth === 0) break
        depth -= 1
      }
    }
    assert.notEqual(end, code.length, 'each NextResponse.json call must close')
    bodies.push(code.slice(start + needle.length, end))
    start = code.indexOf(needle, end + 1)
  }
  return bodies
}

const bodies = responseBodies(source)
assert.ok(bodies.length > 0, 'route must contain response bodies to scan')
for (const body of bodies) {
  assert.doesNotMatch(body, /\b(?:err|error)\?\.message\b/, 'public response body must not forward raw error messages')
  assert.doesNotMatch(body, /\b(?:err|error)\.message\b/, 'public response body must not forward raw error messages')
}

assert.match(source, /error: 'Follow request could not be completed',[\s\S]*code: 'FOLLOW_CREATE_FAILED',[\s\S]*status: 500/,
  'POST must return a stable public error code and status')
assert.match(source, /error: 'Unfollow request could not be completed',[\s\S]*code: 'FOLLOW_DELETE_FAILED',[\s\S]*status: 500/,
  'DELETE must return a stable public error code and status')

console.log(JSON.stringify({ result: 'PHASE45C_FOLLOWS_SAFE_ERRORS_PASS', response_bodies: bodies.length }))
