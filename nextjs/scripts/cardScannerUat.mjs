function asBoolean(value) {
  if (value === true || value === false) return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'y', '1'].includes(normalized)) return true
  if (['false', 'no', 'n', '0'].includes(normalized)) return false
  return null
}

function numericValues(rows) {
  return rows
    .map(row => Number(row.scan_ms))
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const index = Math.min(Math.ceil(values.length * fraction) - 1, values.length - 1)
  return values[Math.max(0, index)]
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function validateUatRows(rows) {
  if (!Array.isArray(rows)) return { valid: false, errors: ['rows must be an array'] }

  const errors = []
  const attempts = new Set()
  rows.forEach((row, index) => {
    const label = `row ${index + 1}`
    if (!isNonEmptyString(row?.card_id)) errors.push(`${label}: card_id is required`)
    if (!Number.isInteger(Number(row?.attempt)) || Number(row.attempt) < 1) {
      errors.push(`${label}: attempt must be a positive integer`)
    }
    if (!isNonEmptyString(row?.device)) errors.push(`${label}: device is required`)
    if (!isNonEmptyString(row?.browser)) errors.push(`${label}: browser is required`)

    for (const field of ['name_group_top5', 'printing_evidence_usable', 'fallback_used']) {
      if (asBoolean(row?.[field]) === null) errors.push(`${label}: ${field} must be boolean`)
    }

    const evidenceUsable = asBoolean(row?.printing_evidence_usable)
    const printingTop5 = asBoolean(row?.printing_top5)
    const printingTop5Blank = row?.printing_top5 === null || row?.printing_top5 === undefined || row?.printing_top5 === ''
    if (evidenceUsable === true && printingTop5 === null) {
      errors.push(`${label}: printing_top5 must be boolean when printing evidence is usable`)
    }
    if (evidenceUsable === false && !printingTop5Blank) {
      errors.push(`${label}: printing_top5 must be blank when printing evidence is unusable`)
    }

    const scanMs = Number(row?.scan_ms)
    if (!Number.isFinite(scanMs) || scanMs <= 0) errors.push(`${label}: scan_ms must be greater than zero`)

    if (isNonEmptyString(row?.card_id) && Number.isInteger(Number(row?.attempt)) && Number(row.attempt) > 0) {
      const attemptKey = `${row.card_id.trim()}\u0000${Number(row.attempt)}`
      if (attempts.has(attemptKey)) errors.push(`${label}: duplicate card_id + attempt`)
      attempts.add(attemptKey)
    }
  })

  return { valid: errors.length === 0, errors }
}

export function summarizeUatRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : []
  const validation = validateUatRows(safeRows)
  const nameGroupTop5Count = safeRows.filter(row => asBoolean(row.name_group_top5) === true).length
  const evidenceRows = safeRows.filter(row => asBoolean(row.printing_evidence_usable) === true)
  const printingTop5Count = evidenceRows.filter(row => asBoolean(row.printing_top5) === true).length
  const scanTimes = numericValues(safeRows)
  const printingMetricAdmissible = evidenceRows.length >= 10

  return {
    total_scans: safeRows.length,
    name_group_top5_count: nameGroupTop5Count,
    name_group_top5_rate: safeRows.length ? nameGroupTop5Count / safeRows.length : null,
    evidence_bearing_scans: evidenceRows.length,
    printing_top5_count: printingTop5Count,
    printing_top5_rate: evidenceRows.length ? printingTop5Count / evidenceRows.length : null,
    printing_metric_admissible: printingMetricAdmissible,
    measurement_rows_valid: validation.valid,
    protocol_admissible: validation.valid && safeRows.length > 0 && printingMetricAdmissible,
    measurement_errors: validation.errors,
    fallback_count: safeRows.filter(row => asBoolean(row.fallback_used) === true).length,
    median_scan_ms: percentile(scanTimes, 0.5),
    p95_scan_ms: percentile(scanTimes, 0.95),
  }
}
