// Checkout idempotency keys must be UUID-shaped, but CartView is served over
// the local Tailscale HTTP UAT URL as well as secure origins. Some mobile
// browsers do not expose crypto.randomUUID() there, so keep a standards-shaped
// fallback rather than crashing while the component initializes.
export function createClientUuid(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    // This is an idempotency key, not an authentication secret. The format
    // fallback preserves the server's UUID validation on legacy HTTP clients.
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
