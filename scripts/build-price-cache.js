/**
 * Build-time script: Download MTGJSON AllPricesToday, extract CardKingdom prices,
 * and upload a compact price map to Supabase Storage for the API to consume.
 * 
 * Run: node scripts/build-price-cache.js
 * 
 * This should be run daily (cron) or before deployments.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', 'nextjs', '.env.local') })
const https = require('https')
const { createGunzip } = require('zlib')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const MTGJSON_URL = 'https://mtgjson.com/api/v5/AllPricesToday.json.gz'
const BUCKET = 'price-cache'
const FILE_NAME = 'ck-prices.json'

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Extract latest price from date-keyed object
function getLatestPrice(dateObj) {
  if (!dateObj || typeof dateObj !== 'object') return null
  const dates = Object.keys(dateObj).sort()
  if (dates.length === 0) return null
  const val = dateObj[dates[dates.length - 1]]
  return typeof val === 'number' ? val : parseFloat(val)
}

async function main() {
  console.log('📥 Downloading MTGJSON AllPricesToday...')

  // Download gzipped file and decompress
  const jsonData = await new Promise((resolve, reject) => {
    https.get(MTGJSON_URL, { headers: { 'User-Agent': 'DansBizarreBazaar/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`MTGJSON returned ${res.statusCode}`))
        return
      }

      const gunzip = createGunzip()
      const chunks = []
      res.pipe(gunzip)
      gunzip.on('data', (chunk) => chunks.push(chunk))
      gunzip.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(parsed)
        } catch (e) {
          reject(e)
        }
      })
      gunzip.on('error', reject)
      res.on('error', reject)
    })
  })

  if (!jsonData || !jsonData.data) {
    console.error('❌ No data in MTGJSON response')
    process.exit(1)
  }

  console.log(`📊 Processing ${Object.keys(jsonData.data).length} card entries...`)

  // Extract only CardKingdom prices into a compact format
  const priceMap = {}
  let ckCount = 0

  for (const [uuid, priceData] of Object.entries(jsonData.data)) {
    if (!priceData || typeof priceData !== 'object') continue
    const paper = priceData.paper
    if (!paper || typeof paper !== 'object') continue

    const ck = paper.cardkingdom || paper.cardKingdom || paper.CardKingdom
    if (!ck || typeof ck !== 'object') continue

    const retail = ck.retail || ck.Retail || {}
    const buylist = ck.buylist || ck.Buylist || {}

    const normalRetail = getLatestPrice(retail.normal || retail.Normal)
    const foilRetail = getLatestPrice(retail.foil || retail.Foil)
    const normalBuylist = getLatestPrice(buylist.normal || buylist.Normal)

    if (normalRetail !== null || foilRetail !== null) {
      priceMap[uuid.toLowerCase()] = {
        n: normalRetail,  // normal retail
        f: foilRetail,    // foil retail
        b: normalBuylist, // normal buylist
      }
      ckCount++
    }
  }

  console.log(`✅ Extracted ${ckCount} CardKingdom prices`)

  // Create compact JSON
  const output = JSON.stringify(priceMap)
  console.log(`📦 Price cache size: ${(output.length / 1024 / 1024).toFixed(1)} MB`)

  // Upload to Supabase Storage
  console.log('☁️  Uploading to Supabase Storage...')

  // Ensure bucket exists
  const { error: bucketError } = await supabase.storage.createBucket(BUCKET, { public: true })
  if (bucketError && !bucketError.message.includes('already exists')) {
    console.warn('⚠️  Bucket creation warning:', bucketError.message)
  }

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(FILE_NAME, Buffer.from(output), {
      contentType: 'application/json',
      upsert: true,
    })

  if (uploadError) {
    console.error('❌ Upload failed:', uploadError.message)
    process.exit(1)
  }

  // Get public URL
  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(FILE_NAME)
  console.log(`✅ Price cache uploaded: ${urlData.publicUrl}`)

  // Also save locally for the import script
  const localPath = require('path').join(__dirname, '..', 'nextjs', 'public', 'ck-prices.json')
  require('fs').mkdirSync(require('path').dirname(localPath), { recursive: true })
  require('fs').writeFileSync(localPath, output)
  console.log(`📁 Also saved locally: ${localPath}`)

  console.log('\n✨ Done!')
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message)
  process.exit(1)
})