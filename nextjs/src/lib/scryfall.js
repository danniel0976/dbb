const CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days

function cacheGet(id) {
  try {
    const raw = localStorage.getItem(`sf:${id}`)
    if (!raw) return null
    const { data, expires } = JSON.parse(raw)
    if (Date.now() > expires) {
      localStorage.removeItem(`sf:${id}`)
      return null
    }
    return data
  } catch {
    return null
  }
}

function cacheSet(id, data) {
  try {
    localStorage.setItem(`sf:${id}`, JSON.stringify({ data, expires: Date.now() + CACHE_TTL }))
  } catch {}
}

let draining = false
const pendingQueue = []
const inFlightMap = new Map()

async function drainQueue() {
  if (draining) return
  draining = true
  while (pendingQueue.length > 0) {
    const { id, resolve, reject } = pendingQueue.shift()
    try {
      const r = await fetch(`https://api.scryfall.com/cards/${id}`)
      const data = await r.json()
      cacheSet(id, data)
      inFlightMap.delete(id)
      resolve(data)
    } catch (err) {
      inFlightMap.delete(id)
      reject(err)
    }
    // 100ms between requests = max 10/s
    await new Promise(r => setTimeout(r, 100))
  }
  draining = false
}

export function getCardById(scryfallId) {
  const cached = cacheGet(scryfallId)
  if (cached) return Promise.resolve(cached)

  if (inFlightMap.has(scryfallId)) return inFlightMap.get(scryfallId)

  const promise = new Promise((resolve, reject) => {
    pendingQueue.push({ id: scryfallId, resolve, reject })
    drainQueue()
  })

  inFlightMap.set(scryfallId, promise)
  return promise
}

export function getImageUrl(cardData) {
  return cardData?.image_uris?.normal ?? cardData?.card_faces?.[0]?.image_uris?.normal ?? null
}
