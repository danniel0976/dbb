import assert from 'node:assert/strict'
import { rankScannerResults, extractScanEvidence } from '../src/lib/cardScanner.mjs'
const e = (id, set, number) => ({ scryfall_id: id, set_code: set, collector_number: number })
const groups = [{ name: 'Ember', editions: [e('wrong','old','1')] }, { name: 'Ember // Ashes', editions: [e('right','new','42')] }]
const ev = { nameQuery: 'Ember', setCode: 'new', collectorNumber: '42' }
const ranked = rankScannerResults(groups, ev)
console.log('synthetic DFC ranking', ranked.map(g=>[g.name,g.scanScore]))
assert.equal(ranked[0].editions[0].scryfall_id, 'right', 'set+collector must beat a short exact title')
assert.equal(ranked[0].editions[0].scanMatches.name, 'exact', 'front face is exact')
assert.equal(rankScannerResults(groups,{nameQuery:'Ashes'})[0].name,'Ember // Ashes','back face is exact')
assert.equal(extractScanEvidence('Ember\nNEW • JA 42/300 R').language,'ja')
console.log('SCANNER_A2_RANK_PASS')
