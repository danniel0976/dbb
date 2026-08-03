#!/usr/bin/env node

// Focused entry point for the Auction overlap source contract. The runner owns
// the structural validator and its negative mutants, avoiding a second weaker
// set of token checks that could disagree with the real execution path.
import { spawnSync } from 'node:child_process'

const runner = new URL('./phase45c-runtime-auction-concurrency.mjs', import.meta.url).pathname
const result = spawnSync(process.execPath, [runner, '--static-only'], { encoding: 'utf8' })
if (result.status !== 0) {
  throw new Error(`auction concurrency source gate failed:\n${result.stderr || result.stdout}`)
}
const line = result.stdout.trim().split(/\r?\n/).at(-1)
let receipt
try {
  receipt = JSON.parse(line)
} catch {
  throw new Error(`auction concurrency source gate emitted no JSON receipt: ${result.stdout}`)
}
if (receipt.result !== 'PHASE45C_AUCTION_CONCURRENCY_STATIC_PASS'
  || receipt.cases !== 16
  || receipt.mutants < 10
  || receipt.fixture !== 'tracked-data-only'
  || receipt.contention !== 'holder-row-scoped') {
  throw new Error(`auction concurrency source receipt is incomplete: ${JSON.stringify(receipt)}`)
}
console.log(JSON.stringify({ ...receipt, result: 'PHASE45C_AUCTION_CONCURRENCY_SOURCE_GATE_PASS' }))
