const CONDITION_MAP = {
  mint: 'M',
  near_mint: 'NM',
  excellent: 'LP',
  good: 'LP',
  light_played: 'LP',
  played: 'MP',
  poor: 'DMG',
}

const FOIL_MAP = {
  normal: 'normal',
  foil: 'foil',
  etched: 'etched',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseRow(rawRow) {
  const scryfallId = (rawRow['Scryfall ID'] || '').trim()

  if (!scryfallId || !UUID_RE.test(scryfallId)) {
    return {
      _skip: true,
      _reason: 'Invalid or missing Scryfall ID',
      _name: rawRow['Name'] || '',
      _set_code: rawRow['Set code'] || '',
      _collector_number: rawRow['Collector number'] || '',
    }
  }

  let quantity = parseInt(rawRow['Quantity'] || '1', 10)
  if (isNaN(quantity) || quantity < 1) quantity = 1
  if (quantity > 9999) quantity = 9999

  const foilRaw = (rawRow['Foil'] || '').trim().toLowerCase()
  const foil = FOIL_MAP[foilRaw] || 'normal'

  const condRaw = (rawRow['Condition'] || '').trim().toLowerCase()
  const condition = CONDITION_MAP[condRaw] || 'NM'

  const priceRaw = (rawRow['Purchase price'] || '').trim()
  const purchase_price = priceRaw && !isNaN(parseFloat(priceRaw)) ? parseFloat(priceRaw) : null

  const purchase_currency = (rawRow['Purchase price currency'] || '').trim() || null

  let date_added = null
  const addedRaw = (rawRow['Added'] || '').trim()
  if (addedRaw) {
    const d = new Date(addedRaw)
    if (!isNaN(d.getTime())) date_added = d.toISOString()
  }

  return {
    scryfall_id: scryfallId,
    quantity,
    foil,
    condition,
    purchase_price,
    purchase_currency,
    date_added,
    _name: rawRow['Name'] || '',
    _set_code: rawRow['Set code'] || '',
    _collector_number: rawRow['Collector number'] || '',
  }
}

function aggregateRows(rows) {
  const map = new Map()

  for (const row of rows) {
    if (row._skip) continue
    const key = `${row.scryfall_id}|${row.foil}|${row.condition}`
    if (map.has(key)) {
      const existing = map.get(key)
      existing.quantity = Math.min(9999, existing.quantity + row.quantity)
    } else {
      map.set(key, { ...row })
    }
  }

  return Array.from(map.values())
}

module.exports = { parseRow, aggregateRows }
