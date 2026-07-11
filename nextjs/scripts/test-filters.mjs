/**
 * Test PostgREST embedded filter syntax for Phase 5.
 * Run: node scripts/test-filters.mjs
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://mnyhpwqskzadkplnhbrx.supabase.co'
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ueWhwd3Fza3phZGtwbG5oYnJ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTI2MjU4MSwiZXhwIjoyMDk2ODM4NTgxfQ.0RKvfOwGAxytcE0DpwHHUqGxPTnW50MYknU9mxny1qY'
const USER_ID = '93238ea1-8b81-4047-a73e-a1c28c8f4cfa'

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

async function count(query) {
  const { count, error } = await query
  if (error) throw error
  return count
}

async function run() {
  console.log('=== Phase 5 filter verification ===\n')

  // Base counts
  const totalLibrary = await count(
    supabase.from('library_cards').select('*', { count: 'exact', head: true }).eq('user_id', USER_ID)
  )
  console.log(`Total library_cards for test user: ${totalLibrary}`)

  // Direct SQL counts for comparison (via RPC would be ideal but let's use JS SDK)

  // Test 1: color filter OR (W or U)
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*, card_index!inner(colors)', { count: 'exact' })
      .eq('user_id', USER_ID)
      .overlaps('card_index.colors', ['W', 'U'])
    if (error) throw error
    console.log(`\nTest 1 - colors OR [W,U] (.overlaps): ${c}`)
  } catch(e) {
    console.log(`Test 1 FAILED (.overlaps):`, e.message)
  }

  // Test 1b: Try cs (contains) for AND
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*, card_index!inner(colors)', { count: 'exact' })
      .eq('user_id', USER_ID)
      .contains('card_index.colors', ['W', 'U'])
    if (error) throw error
    console.log(`Test 1b - colors AND [W,U] (.contains): ${c}`)
  } catch(e) {
    console.log(`Test 1b FAILED (.contains):`, e.message)
  }

  // Test 2: type_line ilike
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*, card_index!inner(type_line)', { count: 'exact' })
      .eq('user_id', USER_ID)
      .ilike('card_index.type_line', '%Creature%')
    if (error) throw error
    console.log(`\nTest 2 - type_line ilike Creature: ${c}`)
  } catch(e) {
    console.log(`Test 2 FAILED:`, e.message)
  }

  // Test 3: cmc range
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*, card_index!inner(cmc)', { count: 'exact' })
      .eq('user_id', USER_ID)
      .gte('card_index.cmc', 1)
      .lte('card_index.cmc', 3)
    if (error) throw error
    console.log(`\nTest 3 - cmc 1..3: ${c}`)
  } catch(e) {
    console.log(`Test 3 FAILED:`, e.message)
  }

  // Test 4: rarity in
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*, card_index!inner(rarity)', { count: 'exact' })
      .eq('user_id', USER_ID)
      .in('card_index.rarity', ['rare', 'mythic'])
    if (error) throw error
    console.log(`\nTest 4 - rarity in [rare, mythic]: ${c}`)
  } catch(e) {
    console.log(`Test 4 FAILED:`, e.message)
  }

  // Test 5: starred
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*', { count: 'exact' })
      .eq('user_id', USER_ID)
      .eq('starred', true)
    if (error) throw error
    console.log(`\nTest 5 - starred: ${c}`)
  } catch(e) {
    console.log(`Test 5 FAILED:`, e.message)
  }

  // Test 6: foil
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*', { count: 'exact' })
      .eq('user_id', USER_ID)
      .eq('foil', 'foil')
    if (error) throw error
    console.log(`\nTest 6 - foil=foil: ${c}`)
  } catch(e) {
    console.log(`Test 6 FAILED:`, e.message)
  }

  // Test 7: set_code
  try {
    // First get a set_code that exists
    const { data: sampleData } = await supabase
      .from('library_cards')
      .select('card_index!inner(set_code)')
      .eq('user_id', USER_ID)
      .limit(5)
    const setCode = sampleData?.[0]?.card_index?.set_code
    if (setCode) {
      const { data, error, count: c } = await supabase
        .from('library_cards')
        .select('*, card_index!inner(set_code)', { count: 'exact' })
        .eq('user_id', USER_ID)
        .eq('card_index.set_code', setCode)
      if (error) throw error
      console.log(`\nTest 7 - set_code=${setCode}: ${c}`)
    }
  } catch(e) {
    console.log(`Test 7 FAILED:`, e.message)
  }

  // Test 8: combined (colors OR [W] + rarity in [rare])
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*, card_index!inner(colors, rarity)', { count: 'exact' })
      .eq('user_id', USER_ID)
      .overlaps('card_index.colors', ['W'])
      .in('card_index.rarity', ['rare', 'mythic'])
    if (error) throw error
    console.log(`\nTest 8 - colors OR [W] + rarity [rare,mythic]: ${c}`)
  } catch(e) {
    console.log(`Test 8 FAILED:`, e.message)
  }

  // Test 9: Colorless (colors = '{}')
  try {
    const { data, error, count: c } = await supabase
      .from('library_cards')
      .select('*, card_index!inner(colors)', { count: 'exact' })
      .eq('user_id', USER_ID)
      .eq('card_index.colors', '{}')
    if (error) throw error
    console.log(`\nTest 9 - colorless (colors={}): ${c}`)
  } catch(e) {
    console.log(`Test 9 FAILED:`, e.message)
  }

  // Get distinct sets
  try {
    const { data, error } = await supabase
      .from('library_cards')
      .select('card_index!inner(set_code, set_name)')
      .eq('user_id', USER_ID)
    if (error) throw error
    const sets = new Map()
    for (const row of data) {
      const ci = row.card_index
      if (ci && !sets.has(ci.set_code)) sets.set(ci.set_code, ci.set_name)
    }
    console.log(`\nDistinct sets in library: ${sets.size} (e.g. ${[...sets.keys()].slice(0,5).join(', ')})`)
  } catch(e) {
    console.log(`Sets query FAILED:`, e.message)
  }
}

run().catch(console.error)
