import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildNameMatchPlans,buildNameOrFilter,runNameMatchPlans} from '../src/lib/catalogNameSearch.mjs'
import {isMissingColumnError} from '../src/lib/catalogSearchCompatibility.mjs'
import {printingPage} from '../src/lib/scannerPrintings.mjs'
const rows=[{scryfall_id:'11111111-1111-4111-8111-111111111111',name:'Lantern Adept',set_code:'tst',collector_number:'1',lang:'en',illustration_id:'art-a',released_at:'2024-01-01',frame:'2015',promo_types:[],promo:false,games:['paper'],has_face_images:false},{scryfall_id:'22222222-2222-4222-8222-222222222222',name:'Lantern Adept',set_code:'prm',collector_number:'2',lang:'en',illustration_id:'art-a',released_at:'2026-01-01',promo_types:['prerelease'],promo:true,games:['paper']}]
let selected=[], loggedIn=true
const db={auth:{getUser:async()=>({data:{user:loggedIn?{id:'synthetic'}:null}})},from:()=>{const query={then:resolve=>resolve({data:rows,count:rows.length,error:null})};for(const fn of ['eq','order','limit','gt','range','ilike','or','overlaps','gte','lte','contains'])query[fn]=()=>query;query.select=fields=>{selected.push(fields);return query};return query}}
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
async function load(file){const source=readFileSync(new URL(file,import.meta.url),'utf8').replace(/^import .*\n/gm,'').replace('export async function GET','async function GET');return new AsyncFunction('NextResponse','createClient','buildNameMatchPlans','buildNameOrFilter','runNameMatchPlans','isMissingColumnError','printingPage',source+'\nreturn GET')({json:(body,{status=200}={})=>({body,status})},async()=>db,buildNameMatchPlans,buildNameOrFilter,runNameMatchPlans,isMissingColumnError,printingPage)}
const search=await load('../src/app/api/catalog/search/route.js')
let response=await search({url:'http://localhost/api/catalog/search?q=Lantern&scan=1'})
assert(selected[0].includes('illustration_id'),'search must retrieve metadata, not just printing endpoint')
assert.equal(response.body.groups[0].editions[0].lang,'en')
assert.equal(response.body.groups[0].editions[0].illustration_id,'art-a')
assert.equal(response.body.groups[0].editions[1].promo,true)
const printings=await load('../src/app/api/catalog/printings/route.js')
response=await printings({url:'http://localhost/api/catalog/printings?name=Lantern%20Adept'})
assert.equal(response.body.groups[0].editions[0].scryfall_id,rows[0].scryfall_id)
response=await printings({url:'http://localhost/api/catalog/printings?name=Lantern%20Adept&set=prm&collector=2'})
assert.equal(response.body.groups[0].editions[0].scryfall_id,rows[1].scryfall_id)
loggedIn=false
assert.equal((await search({url:'http://localhost/api/catalog/search?q=Lantern'})).status,401)
assert.equal((await printings({url:'http://localhost/api/catalog/printings?name=Lantern'})).status,401)
console.log('CATALOG_METADATA_ENDPOINT_PASS real route handlers, metadata and evidence ordering, auth denial (DB seam)')
