import assert from 'node:assert/strict'
import { rankScannerResults } from '../src/lib/cardScanner.mjs'
import { routeScannerMatch, addScannerShelfItem, editScannerShelfItem } from '../src/lib/cardScannerSession.mjs'
const e=(id,more={})=>({scryfall_id:id,set_code:'abc',collector_number:'1',finishes:['nonfoil','foil'],lang:'en',illustration_id:'same',...more})
const groups=[{name:'Generic Sage',editions:[e('a'),e('b')]}]
const ev={nameQuery:'Generic Sage'}
const result=routeScannerMatch(rankScannerResults(groups,ev),ev,{completeIdentity:true})
assert.equal(result.kind,'direct');assert.equal(result.candidate.printingUnverified,true)
const conflict={...ev,setCode:'xyz'}
assert.equal(routeScannerMatch(rankScannerResults(groups,conflict),conflict,{completeIdentity:true}).kind,'uncertain')
const noArt=[{name:'Generic Sage',editions:[e('a',{illustration_id:null}),e('b',{illustration_id:null})]}]
assert.equal(routeScannerMatch(rankScannerResults(noArt,ev),ev,{completeIdentity:true}).kind,'uncertain')
let shelf=addScannerShelfItem([],{...result.candidate,source:'scanner-direct'})
assert.equal(shelf[0].printingUnverified,true)
shelf=addScannerShelfItem(shelf,{cardName:'Generic Sage',edition:e('b'),source:'scanner-confirmed'})
const before=structuredClone(shelf)
const merged=editScannerShelfItem(shelf,shelf[0].shelfId,{edition:e('b'),finish:'nonfoil'})
assert.equal(merged.length,1);assert.equal(merged[0].quantity,2)
assert.deepEqual(shelf,before,'atomic edit must not mutate Undo snapshot')
const foil=editScannerShelfItem(shelf,shelf[0].shelfId,{finish:'foil'})
assert.equal(foil[0].finish,'foil')
console.log('SCANNER_A2_AUTO_EDIT_PASS')
