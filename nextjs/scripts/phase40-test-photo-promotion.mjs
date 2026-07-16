import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = path => readFileSync(resolve(ROOT, path), 'utf8')
let passed = 0

function test(name, assertion) {
  if (!assertion) throw new Error(`FAIL: ${name}`)
  passed += 1
  console.log(`PASS: ${name}`)
}

const upload = read('nextjs/src/app/api/photos/route.js')
const confirm = read('nextjs/src/app/api/photos/confirm/route.js')
const photo = read('nextjs/src/app/api/photos/[libraryCardId]/route.js')
const library = read('nextjs/src/app/api/library/[id]/route.js')
const camera = read('nextjs/src/components/CameraCapture.js')
const facebookRoute = read('nextjs/src/app/api/facebook-export/[libraryCardId]/route.js')
const facebookClient = read('nextjs/src/components/FacebookSaleImage.js')
const migration = read('supabase/migration-017-facebook-export-photo-versions.sql')
const contractMigration = read('supabase/migration-018-facebook-export-photo-contract.sql')

test('uploads use immutable UUID candidate paths', upload.includes('crypto.randomUUID()') && upload.includes('${user.id}/${libraryCardId}/'))
test('client no longer requests overwrite semantics', !camera.includes("'x-upsert': 'true'"))
test('confirm validates a versioned owner/card path', confirm.includes('candidatePattern') && confirm.includes('expectedPrefix'))
test('confirm uses transactional promotion RPC', confirm.includes("sc.rpc('promote_card_photo'"))
test('failed promotion removes candidate and returns failure', confirm.includes('await sc.storage.from(BUCKET).remove([storagePath])') && confirm.includes("status: 500"))
test('old canonical bytes are removed only after promotion', confirm.indexOf("sc.rpc('promote_card_photo'") < confirm.indexOf('previous photo cleanup error'))
test('card deletion prefix cleanup drains repeated 1000-object pages', library.includes('page < 100') && library.includes('offset: 0'))
test('interactive photo deletion receives exact canonical path from RPC', photo.includes('data: deletedStoragePath') && photo.includes("sc.rpc('delete_card_photo_and_invalidate_export'"))
test('interactive photo deletion removes only the returned canonical path', photo.includes('remove([deletedStoragePath])') && !photo.includes('removePhotoPrefix') && !photo.includes('.list('))
test('photo deletion removes metadata atomically before exact bytes', photo.indexOf("sc.rpc('delete_card_photo_and_invalidate_export'") < photo.indexOf('remove([deletedStoragePath])'))
test('card deletion removes database row before bytes', library.indexOf(".from('library_cards')\n    .delete()") < library.lastIndexOf('removePhotoPrefix(sc'))
test('condition or finish changes use atomic update and invalidation', library.includes("rpc('update_library_card_and_invalidate_export'") && migration.includes('UPDATE public.library_cards') && migration.includes('DELETE FROM public.fb_export_snapshots'))
test('migration creates owner-only snapshot RLS', migration.includes('CREATE TABLE public.fb_export_snapshots') && migration.includes('auth.uid() = user_id'))
test('contract migration removes legacy direct photo mutation paths', contractMigration.includes('card_photos_versioned_storage_path_check') && contractMigration.includes('DROP POLICY IF EXISTS "owner update card photos"') && contractMigration.includes('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.card_photos'))
test('promotion locks ownership and invalidates snapshot atomically', migration.includes('FOR UPDATE;') && migration.includes('DELETE FROM public.fb_export_snapshots'))
test('privileged RPCs enforce service-role claims internally', (migration.match(/service role required/g) || []).length === 4)
test('snapshot save locks and verifies card details and canonical photo', migration.includes('save_fb_export_snapshot') && migration.includes('card details changed during generation') && migration.includes('condition photo changed during generation'))
test('server creates and signs the generation preparation', facebookRoute.includes('generation_id: randomUUID()') && facebookRoute.includes('preparation_token: signPreparation(preparation)') && facebookRoute.includes("createHmac('sha256'"))
test('preparation contains exact canonical photo URL, labels and prices', facebookRoute.includes('photo_storage_path: photoPath') && facebookRoute.includes('photo_url: signedData.signedUrl') && facebookRoute.includes('card_name:') && facebookRoute.includes('condition:') && facebookRoute.includes('finish:') && facebookRoute.includes('ckd_usd: price.ckdUsd') && facebookRoute.includes('myr_price: price.myrPrice'))
test('prepare and commit bodies are strongly allowlisted', facebookRoute.includes("new Set(['action', 'multiplier'])") && facebookRoute.includes("new Set(['action', 'preparation_token'])") && facebookRoute.includes("body.action !== 'prepare' && body.action !== 'commit'"))
test('client keeps condition-photo reads inside the signed preparation', !facebookClient.includes('`/api/photos/${libraryRow.id}`'))
test('client shows a non-final CKD and selected-multiplier estimate before generation', facebookClient.includes("fetch('/api/pricing/batch'") && facebookClient.includes('CKD reference $') && facebookClient.includes('Estimated RM') && facebookClient.includes('Reference only. Final price is verified by the server when you generate.'))
test('client draws every sale-image field from the prepared bundle', facebookClient.includes('fetch(prepared.photo_url)') && facebookClient.includes('const cardName = prepared.card_name') && facebookClient.includes('prepared.condition') && facebookClient.includes('prepared.finish') && facebookClient.includes('prepared.myr_price.toFixed(2)') && facebookClient.includes('prepared.ckd_usd.toFixed(2)'))
test('client canvas remains authoritative and does not draw reference prices', !facebookClient.includes('ctx.fillText(`RM ${referenceMyr') && !facebookClient.includes('ctx.fillText(`CKD $${referenceCkdUsd'))
test('snapshot commit occurs only after JPEG blob creation', facebookClient.indexOf('const blob = await canvasBlob(canvas)') < facebookClient.indexOf("action: 'commit'"))
test('snapshot commit uses only the signed preparation token', facebookClient.includes("action: 'commit', preparation_token: prepared.preparation_token") && facebookRoute.includes('const preparation = verifyPreparation(body.preparation_token)'))
test('server recomputes authoritative price and rejects drift with 409', facebookRoute.includes('currentPrice(context.card, preparation.multiplier)') && facebookRoute.includes('preparationDrift(') && facebookRoute.includes("code: 'EXPORT_PREPARATION_STALE'") && facebookRoute.includes('{ status: 409 }'))
test('price drift refresh is consumed by the client for retry', facebookClient.includes('snapshotResponse.status === 409') && facebookClient.includes('const current = snapshotData.current') && facebookClient.includes('setMultiplier(current.multiplier)') && facebookClient.includes('setQuote({ multiplier: current.multiplier'))
test('snapshot binds the exact prepared generation, photo, details and price', facebookRoute.includes('p_generation_id: preparedValues.generation_id') && facebookRoute.includes('p_photo_storage_path: preparedValues.photo_storage_path') && facebookRoute.includes('p_condition: preparedValues.condition') && facebookRoute.includes('p_foil: preparedValues.finish') && facebookRoute.includes('p_ckd_usd: preparedValues.ckd_usd') && facebookRoute.includes('p_myr_price: preparedValues.myr_price'))
test('preview, save and share reuse the same committed blob', facebookClient.includes('setResult({\n        blob,') && facebookClient.includes('<img src={result.url}') && facebookClient.includes('link.href = result.url') && facebookClient.includes('new File([result.blob]'))

console.log(`\n${passed} Phase 40 checks passed.`)
