import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
const url=new URL('../../supabase/migrations/20261021000000_catalog_printing_metadata.sql',import.meta.url)
assert(existsSync(url),'one forward catalog metadata migration is required')
const sql=readFileSync(url,'utf8').replace(/--[^\n]*/g,'')
const fields=['lang','oracle_id','illustration_id','released_at','frame','frame_effects','promo_types','border_color','has_face_images','face_illustration_ids','promo','set_type','layout','games']
for(const field of fields){
  assert.match(sql,new RegExp('ADD COLUMN IF NOT EXISTS '+field+'\\b'),field)
  assert.match(sql,new RegExp(field+' = EXCLUDED\\.'+field+'\\b'),'publisher must carry '+field)
}
assert.match(sql,/ALTER TABLE public\.catalog_refresh_staging/)
assert.match(sql,/p_row_count < 100000/)
assert.match(sql,/p_row_count::numeric \/ \(p_row_count \+ p_skipped_count\) < 0\.85/)
assert.match(sql,/FROM PUBLIC, anon, authenticated/)
assert.doesNotMatch(sql,/GRANT[^;]+TO (?:anon|authenticated)/i)
assert.doesNotMatch(sql,/CREATE INDEX/i,'existing exact-name index supports all queries; no new index budget')
const gate=readFileSync(new URL('../../supabase/tests/uat_schema_gate.sql',import.meta.url),'utf8')
assert.match(gate,/'20261021000000'/)
assert.match(gate,/exactly 17 migration/)
console.log('CATALOG_METADATA_SQL_PASS atomic publisher/completeness/ACL/17-version gate')
