import assert from 'node:assert/strict'
import {preferPrintings, printingPage} from '../src/lib/scannerPrintings.mjs'
import {routeScannerMatch} from '../src/lib/cardScannerSession.mjs'
const base={name:'Lantern Adept',set_code:'old',collector_number:'7',lang:'en',released_at:'2020-01-01',games:['paper'],illustration_id:'art-a',frame:'2015',promo:false,promo_types:[],frame_effects:[]}
const rows=[{...base,scryfall_id:'regular',released_at:'2024-01-01'}, {...base,scryfall_id:'promo',set_code:'prm',promo_types:['prerelease'],released_at:'2026-01-01'}, {...base,scryfall_id:'showcase',set_code:'alt',frame_effects:['showcase'],released_at:'2026-01-01'}, {...base,scryfall_id:'art',set_code:'art',set_type:'art_series',released_at:'2026-01-01'}, {...base,scryfall_id:'ja',lang:'ja',set_code:'new',released_at:'2025-01-01'}]
assert.equal(preferPrintings(rows)[0].scryfall_id,'regular','promo_types alone must exclude promo defaults')
assert.equal(preferPrintings(rows,{language:'ja'})[0].scryfall_id,'ja')
assert.equal(preferPrintings(rows,{lastSet:'new',setLock:'old',setCode:'new',collectorNumber:'7'})[0].scryfall_id,'regular')
assert.equal(preferPrintings(rows,{lastSet:'new',setCode:'old',collectorNumber:'7'})[0].scryfall_id,'ja')
assert.equal(preferPrintings(rows,{setCode:'new',collectorNumber:'007'})[0].scryfall_id,'ja')
assert.equal(preferPrintings(rows,{setCode:'old',collectorNumber:'7',preferredId:'promo'})[0].scryfall_id,'regular','footer outranks recognized-printing hint')
assert.equal(preferPrintings(rows,{setLock:'old',preferredId:'ja'})[0].scryfall_id,'regular','set lock outranks recognized-printing hint')
const realArtShape={...base,scryfall_id:'art-series',layout:'art_series',set_type:'memorabilia',released_at:'2026-01-01'}
assert.equal(preferPrintings([realArtShape,rows[0]])[0].scryfall_id,'regular','Scryfall art series uses layout, not set_type')
assert.equal(preferPrintings([{...base,scryfall_id:'ja-old',lang:'ja'}, {...base,scryfall_id:'fr-new',lang:'fr',released_at:'2025-01-01'}])[0].scryfall_id,'fr-new','missing language prior must not sort language lexically before release')
const page=await printingPage(async()=>({data:rows}),{name:base.name})
assert.equal(page.groups[0].editions[0].scryfall_id,'regular')
const family=rows.slice(0,2).map(e=>({...e,scanScore:100,scanMatches:{name:'exact'}}))
assert.equal(routeScannerMatch([{name:base.name,editions:family}],{nameQuery:base.name},{completeIdentity:true}).kind,'direct')
const dfc=family.map(e=>({...e,has_face_images:true,face_illustration_ids:['art-a', e.scryfall_id]}))
assert.equal(routeScannerMatch([{name:base.name,editions:dfc}],{nameQuery:base.name},{completeIdentity:true}).kind,'uncertain','shared front alone is not a DFC art-family proof')
console.log('SCANNER_METADATA_PASS preference tiers, promo exclusion, newest fallback, DFC identity')
