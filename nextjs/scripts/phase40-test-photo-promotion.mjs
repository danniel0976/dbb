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
const migration = read('supabase/migration-017-facebook-export-photo-versions.sql')

test('uploads use immutable UUID candidate paths', upload.includes('crypto.randomUUID()') && upload.includes('${user.id}/${libraryCardId}/'))
test('client no longer requests overwrite semantics', !camera.includes("'x-upsert': 'true'"))
test('confirm validates a versioned owner/card path', confirm.includes('candidatePattern') && confirm.includes('expectedPrefix'))
test('confirm uses transactional promotion RPC', confirm.includes("sc.rpc('promote_card_photo'"))
test('failed promotion removes candidate and returns failure', confirm.includes('await sc.storage.from(BUCKET).remove([storagePath])') && confirm.includes("status: 500"))
test('old canonical bytes are removed only after promotion', confirm.indexOf("sc.rpc('promote_card_photo'") < confirm.indexOf('previous photo cleanup error'))
test('prefix cleanup drains repeated 1000-object pages', photo.includes('page < 100') && library.includes('page < 100') && photo.includes('offset: 0'))
test('photo deletion removes metadata atomically before bytes', photo.indexOf("sc.rpc('delete_card_photo_and_invalidate_export'") < photo.lastIndexOf('removePhotoPrefix(sc'))
test('card deletion removes database row before bytes', library.indexOf(".from('library_cards')\n    .delete()") < library.lastIndexOf('removePhotoPrefix(sc'))
test('condition or finish changes use atomic update and invalidation', library.includes("rpc('update_library_card_and_invalidate_export'") && migration.includes('UPDATE public.library_cards') && migration.includes('DELETE FROM public.fb_export_snapshots'))
test('migration creates owner-only snapshot RLS', migration.includes('CREATE TABLE public.fb_export_snapshots') && migration.includes('auth.uid() = user_id'))
test('promotion locks ownership and invalidates snapshot atomically', migration.includes('FOR UPDATE;') && migration.includes('DELETE FROM public.fb_export_snapshots'))
test('privileged RPCs enforce service-role claims internally', (migration.match(/service role required/g) || []).length === 4)
test('snapshot save locks and verifies card details and canonical photo', migration.includes('save_fb_export_snapshot') && migration.includes('card details changed during generation') && migration.includes('condition photo changed during generation'))

console.log(`\n${passed} Phase 40 checks passed.`)
