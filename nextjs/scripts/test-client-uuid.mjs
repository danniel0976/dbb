import assert from 'node:assert/strict'
import { createClientUuid } from '../src/lib/clientUuid.mjs'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const native = createClientUuid({ randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' })
assert.equal(native, '123e4567-e89b-42d3-a456-426614174000')

const fallback = createClientUuid({ getRandomValues: bytes => bytes.fill(0) })
assert.match(fallback, UUID_V4)

const noCryptoFallback = createClientUuid(null)
assert.match(noCryptoFallback, UUID_V4)

console.log('CLIENT_UUID_PASS')
