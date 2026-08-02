// Pure merge/verification rules for the shared `price-cache/ck-prices.json`
// object that the Phase 45C click-through fixture writes into.
//
// The bucket is shared with real Card Kingdom imports, so the fixture owns
// exactly its four synthetic keys and must hand back everything else
// byte-for-byte. The rules live here, away from the seeder's Supabase side
// effects, so they can be exercised directly by the tracked gate.
//
// Two failure modes this module exists to make impossible:
//   1. A malformed nested group (`prices: null`, `prices: []`, `prices: "x"`)
//      used to be coerced to `{}` and then written over the real data. Any
//      shape the fixture cannot merge into now aborts before the upload.
//   2. Fixture-key exclusion used to be `key in FIXTURE_PRICE_IDS`, which walks
//      the prototype chain. A genuine cache row named `constructor`,
//      `toString`, `valueOf` or `hasOwnProperty` was therefore classified as a
//      fixture key and dropped out of the preserved set, so nothing checked
//      that it survived. Every membership test and every lookup here is
//      own-property only.

// A JSON object literal: not null, not an array, not a scalar. Bare
// `typeof x === 'object'` accepts null and arrays and is the reason the old
// guard let malformed caches through.
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function hasOwn(object, key) {
  return isPlainObject(object) && Object.prototype.hasOwnProperty.call(object, key)
}

// Reading `object[key]` directly resolves inherited members — `cache.prices
// .constructor` is a function, not a missing price row. Only own properties
// are ever observed.
export function ownValue(object, key) {
  return hasOwn(object, key) ? object[key] : undefined
}

function ownEntries(object) {
  return Object.entries(object).filter(([key]) => hasOwn(object, key))
}

// A nested group must be an object or genuinely absent. `null`, arrays and
// scalars abort: the fixture has no safe way to merge into them, and silently
// substituting `{}` would destroy whatever the bucket really held.
export function requireNestedCacheGroup(existing, key) {
  if (!hasOwn(existing, key)) return {}
  const value = existing[key]
  if (!isPlainObject(value)) {
    const shape = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    throw new Error(`price-cache ${key} is ${shape}, not a JSON object; refusing to overwrite it`)
  }
  return value
}

// Build the object that will be uploaded plus the snapshot of everything the
// fixture does not own. Throws before either is produced if the existing cache
// has a shape the fixture cannot merge into.
export function buildPriceCacheMerge({ existing, fixturePrices, fixtureNames }) {
  if (existing != null && !isPlainObject(existing)) {
    throw new Error('price-cache is not a JSON object; refusing to overwrite it')
  }
  const basePrices = requireNestedCacheGroup(existing, 'prices')
  const baseNames = requireNestedCacheGroup(existing, 'names')

  const preserved = {
    prices: Object.fromEntries(ownEntries(basePrices).filter(([id]) => !hasOwn(fixturePrices, id))),
    names: Object.fromEntries(ownEntries(baseNames).filter(([name]) => !hasOwn(fixtureNames, name))),
    other: Object.fromEntries(
      ownEntries(existing || {}).filter(([key]) => key !== 'prices' && key !== 'names')),
  }

  const merged = {
    ...preserved.other,
    prices: { ...basePrices, ...fixturePrices },
    names: { ...baseNames, ...fixtureNames },
  }

  return { preserved, merged }
}

// Re-read verification: every unrelated key came back unchanged and every
// fixture key landed. Run against the object actually downloaded after the
// upload, never against the object that was uploaded.
export function assertPriceCachePreserved({ after, preserved, fixturePrices, fixtureNames }) {
  if (!isPlainObject(after)) {
    throw new Error('price-cache fixture write did not produce a readable object')
  }
  const afterPrices = requireNestedCacheGroup(after, 'prices')
  const afterNames = requireNestedCacheGroup(after, 'names')

  for (const [group, before, current] of [
    ['prices', preserved.prices, afterPrices],
    ['names', preserved.names, afterNames],
  ]) {
    for (const [key, value] of Object.entries(before)) {
      if (JSON.stringify(ownValue(current, key)) !== JSON.stringify(value)) {
        throw new Error(`price-cache fixture clobbered unrelated ${group} key ${key}`)
      }
    }
  }
  for (const [key, value] of Object.entries(preserved.other)) {
    if (JSON.stringify(ownValue(after, key)) !== JSON.stringify(value)) {
      throw new Error(`price-cache fixture clobbered unrelated top-level key ${key}`)
    }
  }
  for (const [id, entry] of Object.entries(fixturePrices)) {
    if (JSON.stringify(ownValue(afterPrices, id)) !== JSON.stringify(entry)) {
      throw new Error(`price-cache fixture id ${id} did not land`)
    }
  }
  for (const [name, entry] of Object.entries(fixtureNames)) {
    if (JSON.stringify(ownValue(afterNames, name)) !== JSON.stringify(entry)) {
      throw new Error(`price-cache fixture name ${name} did not land`)
    }
  }
}
