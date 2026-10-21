import assert from 'node:assert/strict'
import * as p from '../src/lib/scannerPrintings.mjs'
const rows = Array.from({length:725},(_,i)=>({name:'Dawn // Dusk',scryfall_id:String(i).padStart(4,'0'),lang:i%2?'ja':'en',set_code:'abc',released_at:'2020-01-01',games:['paper'],finishes:['nonfoil','foil']}))
const query = async (after,limit) => ({data:rows.filter(r=>!after||r.scryfall_id>after).slice(0,limit)})
const first = await p.printingPage(query,{name:'Dawn // Dusk',limit:40,preferredId:'0724'})
assert.equal(first.total,725)
assert.equal(first.groups[0].editions[0].scryfall_id,'0724')
let all=first.groups.flatMap(g=>g.editions), cursor=first.next_cursor
while(cursor) { const page=await p.printingPage(query,{name:'Dawn // Dusk',limit:40,preferredId:'0724',cursor});all.push(...page.groups.flatMap(g=>g.editions));cursor=page.next_cursor }
assert.equal(new Set(all.map(e=>e.scryfall_id)).size,725)
assert.equal(p.catalogImage({card_faces:[{image_uris:{small:'https://example.invalid/front.jpg'}}]}).small,'https://example.invalid/front.jpg')
const opts=[{scryfall_id:'promo',lang:'en',promo:true,released_at:'2026-01-01'},{scryfall_id:'normal',lang:'en',released_at:'2024-01-01'},{scryfall_id:'ja',lang:'ja',released_at:'2025-01-01'}]
assert.equal(p.preferPrintings(opts)[0].scryfall_id,'normal')
assert.equal(p.preferPrintings(opts,{language:'ja'})[0].scryfall_id,'ja')
assert.equal(p.preferPrintings(opts.map((e,i)=>({...e,set_code:String(i)})),{setLock:'2'})[0].scryfall_id,'ja')
console.log('SCANNER_A2_PRINTINGS_PASS 725 rows, cursor uniqueness, preferred/language/paper order, DFC')
