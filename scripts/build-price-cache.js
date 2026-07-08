/**
 * Build-time script: Download MTGJSON AllPricesToday, extract CardKingdom prices,
 * and upload a compact price map to Supabase Storage for the API to consume.
 *
 * Run: cd nextjs && node ../scripts/build-price-cache.js
 *   OR: node scripts/build-price-cache.js (with NODE_PATH set)
 *
 * This should be run daily (cron) or before deployments.
 */

const path = require('path')
const nextjsDir = path.join(__dirname, '..', 'nextjs')
const envPath = path.join(nextjsDir, '.env.local')

// Load env vars from .env.local
const fs = require('fs')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8')
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim()
    }
  }
  console.log('Loaded env from', envPath)
} else {
  console.error('.env.local not found at', envPath)
}

const https = require('https')
const { createGunzip } = require('zlib')

// Resolve supabase-js from nextjs/node_modules
let createClient
try {
  const supabaseModule = require(path.join(nextjsDir, 'node_modules', '@supabase', 'supabase-js'))
  createClient = supabaseModule.createClient
} catch (e) {
  console.error('Cannot find @supabase/supabase-js. Run: cd nextjs && npm install')
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const MTGJSON_URL = 'https://mtgjson.com/api/v5/AllPricesToday.json.gz'
const BUCKET = 'price-cache'
const FILE_NAME = 'ck-prices.json'

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Extract latest price from date-keyed object like {"2026-07-07": 7.99}
function getLatestPrice(dateObj) {
  if (!dateObj || typeof dateObj !== 'object') return null
  const dates = Object.keys(dateObj).sort()
  if (dates.length === 0) return null
  const val = dateObj[dates[dates.length - 1]]
  return typeof val === 'number' ? val : parseFloat(val)
}

function downloadGzippedJson(url) {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl) => {
      https.get(requestUrl, { headers: { 'User-Agent': 'DansBizarreBazaar/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location
          console.log(`Redirecting to ${redirectUrl}`)
          doRequest(redirectUrl)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${requestUrl}`))
          return
        }

        const gunzip = createGunzip()
        const chunks = []
        res.pipe(gunzip)
        gunzip.on('data', (chunk) => chunks.push(chunk))
        gunzip.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (e) { reject(e) }
        })
        gunzip.on('error', reject)
      }).on('error', reject)
    }
    doRequest(url)
  })
}

async function main() {
  console.log('Downloading MTGJSON AllPricesToday (gzipped)...')
  const jsonData = await downloadGzippedJson(MTGJSON_URL)

  if (!jsonData || !jsonData.data) {
    console.error('No data in MTGJSON response')
    process.exit(1)
  }

  console.log(`Processing ${Object.keys(jsonData.data).length} card entries...`)

  // Extract only CardKingdom prices — compact format
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
        n: normalRetail,
        f: foilRetail,
        b: normalBuylist,
      }
      ckCount++
    }
  }

  console.log(`Extracted ${ckCount} CardKingdom prices`)

  // Compact JSON
  const output = JSON.stringify(priceMap)
  console.log(`Price cache size: ${(output.length / 1024 / 1024).toFixed(1)} MB`)

  // Upload to Supabase Storage
  console.log('Uploading to Supabase Storage...')

  // Ensure bucket exists (public read)
  const { error: bucketError } = await supabase.storage.createBucket(BUCKET, { public: true })
  if (bucketError && !bucketError.message.includes('already exists')) {
    console.warn('Bucket creation warning:', bucketError.message)
  }

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(FILE_NAME, Buffer.from(output), {
      contentType: 'application/json',
      upsert: true,
    })

  if (uploadError) {
    console.error('Upload failed:', uploadError.message)
    process.exit(1)
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(FILE_NAME)
  console.log(`Price cache uploaded: ${urlData.publicUrl}`)

  // Also save locally as fallback
  const localPath = path.join(nextjsDir, 'public', 'ck-prices.json')
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  fs.writeFileSync(localPath, output)
  console.log(`Also saved locally: ${localPath}`)

  console.log('\nDone!')
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})