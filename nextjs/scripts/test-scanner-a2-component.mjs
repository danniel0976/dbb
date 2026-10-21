import assert from 'node:assert/strict'
import { scannerComponentHarness, findScannerElement, scannerElementText } from './lib/scannerComponentHarness.mjs'
import * as parser from '../src/lib/cardScanner.mjs'
import * as session from '../src/lib/cardScannerSession.mjs'
import * as view from '../src/lib/cardScannerView.mjs'
import * as viewport from '../src/lib/scannerViewport.mjs'
import * as printings from '../src/lib/scannerPrintings.mjs'
import { settleScanEvidence } from '../src/lib/cardScannerState.mjs'
const stub=name=>Object.assign(()=>null,{displayName:name})
const deps={'react-dom':{createPortal:n=>n},'@/lib/cardScanner.mjs':parser,'@/lib/cardScannerSession.mjs':session,'@/lib/cardScannerView.mjs':view,'@/lib/scannerViewport.mjs':viewport,'@/lib/scannerPrintings.mjs':printings,'@/lib/cardScannerVisualBrowser.mjs':{compareScannerCandidatesVisually:async groups=>({groups,status:'unavailable'})},'./CardScannerPanel':{default:stub('Panel'),terminateScannerWorker(){}},'./ScannerPrintingSelection':{PrintingSelectionPanel:stub('Picker'),CandidateCardName:stub('Name')},'./ScannerShelfNotices':{HeldScansBanner:stub('Held'),ScannerExitPrompt:stub('Exit')}}
const saved={document:globalThis.document,fetch:globalThis.fetch}
globalThis.document={body:{style:{}},addEventListener(){},removeEventListener(){}}
const h=scannerComponentHarness('components/AddCardModal.js',deps)
const props={binders:[{id:'generic',name:'Generic binder'}],onClose(){},onAdded(){throw Error('unexpected inventory write')}}
const render=()=>h.render(props), panel=t=>findScannerElement(t,e=>e.type?.displayName==='Panel'),picker=t=>findScannerElement(t,e=>e.type?.displayName==='Picker')
const edition=(id,set)=>({scryfall_id:id,set_code:set,collector_number:'42',illustration_id:'generic-art',lang:'en',finishes:['nonfoil','foil'],released_at:'2025-01-01'})
const a=edition('generic-a','abc'),b=edition('generic-b','def')
let requests=[]
globalThis.fetch=async url=>{requests.push(url);assert.ok(url.startsWith('/api/catalog/'),'matching/editing must never write inventory');const family=url.startsWith('/api/catalog/printings');return {ok:true,json:async()=>({groups:[{name:'Generic Sage',editions:[a,b]}],total:2,has_more:false,next_cursor:null})}}
try {
 let t=render();findScannerElement(t,e=>e.type==='button'&&scannerElementText(e).includes('Scan card')).props.onClick();t=render()
 await settleScanEvidence({evidence:{nameQuery:'Generic Sage'},onEvidence:panel(t).props.onEvidence,isCancelled:()=>false});t=render()
 assert.equal(panel(t).props.shelf.length,1);assert.equal(panel(t).props.shelf[0].printingUnverified,true);assert.equal(picker(t),null,'certain same-art name auto-adds without chooser')
 await settleScanEvidence({evidence:{nameQuery:'Generic Sage',setCode:'def',collectorNumber:'42'},onEvidence:panel(t).props.onEvidence,isCancelled:()=>false});t=render()
 assert.equal(panel(t).props.shelf.length,2)
 const before=structuredClone(panel(t).props.shelf)
 panel(t).props.onChangePrinting(before[0].shelfId);await new Promise(r=>setImmediate(r));t=render()
 assert.ok(picker(t));const option=picker(t).props.children.find(row=>row.props.edition.scryfall_id==='generic-b');option.props.onSelect(option.props.edition,option.props.cardName);t=render()
 assert.equal(panel(t).props.shelf.length,1);assert.equal(panel(t).props.shelf[0].quantity,2)
 panel(t).props.onUndoShelfEdit();t=render();assert.deepEqual(panel(t).props.shelf,before,'Undo restores both collided rows exactly')
 let release;globalThis.fetch=()=>new Promise(r=>{release=r})
 const saving=panel(t).props.onConfirmBatch();t=render();const frozen=structuredClone(panel(t).props.shelf)
 panel(t).props.onUndoShelfEdit();panel(t).props.onChangePrinting(frozen[0].shelfId);t=render();assert.deepEqual(panel(t).props.shelf,frozen)
 release({ok:false,status:400,json:async()=>({error:'Synthetic rejection'})});await saving
 console.log('SCANNER_A2_COMPONENT_PASS auto-add badge, printing collision, exact Undo, pending freeze; no library write before batch confirm')
} finally {h.unmount();globalThis.document=saved.document;globalThis.fetch=saved.fetch}
