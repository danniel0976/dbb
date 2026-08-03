#!/usr/bin/env node

// Idempotent Phase 45C REST-UAT fixture. This script is intentionally scoped
// to the disposable local Supabase project and never creates hosted data.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
config({ path: path.join(APP_ROOT, '.env.local') })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) throw new Error('Missing local Supabase environment')
const parsed = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
  throw new Error(`Refusing non-local Supabase host: ${parsed.hostname}`)
}

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const accounts = [
  { email: 'dan@dbb.test', password: 'password1234', username: 'dan_uat' },
  { email: 'bidder@dbb.test', password: 'password1234', username: 'bidder_uat' },
]

async function findUser(email) {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw error
  return (data.users || []).find(user => user.email?.toLowerCase() === email) || null
}

async function ensureAccount(account) {
  let user = await findUser(account.email)
  if (!user) {
    const result = await db.auth.admin.createUser({
      email: account.email,
      password: account.password,
      email_confirm: true,
      user_metadata: { username: account.username, display_name: account.username },
    })
    if (result.error) throw result.error
    user = result.data.user
  }
  if (!user?.id) throw new Error(`Could not resolve ${account.email}`)
  return user
}

const users = {}
for (const account of accounts) users[account.email] = await ensureAccount(account)

const danId = users['dan@dbb.test'].id
const { error: profileError } = await db.from('profiles').update({
  merchant_bank_name: 'DBB local UAT only',
  merchant_account_name: 'Dan UAT',
  merchant_account_number: '0000000000',
  merchant_duitnow_id: null,
  merchant_payment_instructions: 'Synthetic fixture; not payment data.',
  merchant_profile_completed_at: new Date().toISOString(),
}).eq('id', danId)
if (profileError) throw profileError

const { data: cards, error: cardError } = await db.from('library_cards')
  .select('id, user_id, binder_id, scryfall_id, quantity, foil, condition, language, starred, card_index(name)')
  .eq('user_id', danId).order('id')
if (cardError) throw cardError

const cardIds = (cards || []).map(card => card.id)
let photos = []
if (cardIds.length) {
  const result = await db.from('card_photos').select('id, library_card_id, storage_path').in('library_card_id', cardIds).order('id')
  if (result.error) throw result.error
  photos = result.data || []
}

console.log(JSON.stringify({
  fixture: 'phase45c-rest-uat',
  supabase_host: parsed.hostname,
  accounts: Object.fromEntries(Object.entries(users).map(([email, user]) => [email, { id: user.id }])),
  dan: { id: danId, merchant_profile: 'synthetic-complete' },
  cards: (cards || []).map(card => ({
    id: card.id,
    scryfall_id: card.scryfall_id,
    name: card.card_index?.name || null,
    quantity: card.quantity,
    foil: card.foil,
    condition: card.condition,
    photo_backed: photos.some(photo => photo.library_card_id === card.id),
  })),
  photos: photos.map(photo => ({ id: photo.id, library_card_id: photo.library_card_id, storage_path: photo.storage_path })),
  auctions: [],
  bids: [],
  follows: [],
}, null, 2))
