import { readFileSync } from 'node:fs'
import { summarizeUatRows } from './cardScannerUat.mjs'

const inputPath = process.argv[2]
if (!inputPath) {
  console.error('Usage: node scripts/summarize-card-scanner-uat.mjs <results.jsonl|results.json>')
  process.exit(2)
}

function loadRows(filePath) {
  const text = readFileSync(filePath, 'utf8').trim()
  if (!text) return []
  if (filePath.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : parsed.rows
  }
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

try {
  const summary = summarizeUatRows(loadRows(inputPath))
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = summary.protocol_admissible ? 0 : 1
} catch (error) {
  console.error(`UAT summary failed: ${error.message}`)
  process.exit(1)
}
