#!/usr/bin/env node
/**
 * Populate missing card images from Scryfall
 * Run: node scripts/populate-images.js
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '../nextjs/.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role for updates
);

const SCRYFAH_BASE = 'https://api.scryfall.com/cards/search';
const RATE_LIMIT_DELAY = 100; // ms between requests (Scryfall allows ~10/sec)

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCardImages(setCode, collectorNumber) {
  try {
    const url = `${SCRYFAH_BASE}?q=set:${encodeURIComponent(setCode)}+cn:${encodeURIComponent(collectorNumber)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DansBizarreBazaar/1.0' }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data.data || data.data.length === 0) return null;
    
    const card = data.data[0];
    
    if (card.image_uris) {
      return {
        image_png_url: card.image_uris.png,
        image_crop_url: card.image_uris.normal
      };
    } else if (card.card_faces && card.card_faces[0].image_uris) {
      const face = card.card_faces[0];
      return {
        image_png_url: face.image_uris.png,
        image_crop_url: face.image_uris.normal
      };
    }
    
    return null;
  } catch (error) {
    console.error(`Error fetching ${setCode} ${collectorNumber}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('🔍 Finding cards without images...');
  
  // Get all cards missing images
  const { data: cards, error } = await supabase
    .from('cards')
    .select('id, card_name, set_code, collector_number, image_png_url, image_crop_url')
    .is('image_png_url', null)
    .limit(500); // Process in batches
  
  if (error) {
    console.error('❌ Failed to fetch cards:', error.message);
    return;
  }
  
  console.log(`📦 Found ${cards.length} cards without images`);
  
  let updated = 0;
  let failed = 0;
  let notFound = 0;
  
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    process.stdout.write(`\r📸 Processing ${i + 1}/${cards.length}: ${card.card_name}...`);
    
    if (!card.set_code || !card.collector_number) {
      console.log(`\n⚠️  Skipping "${card.card_name}" - missing set_code or collector_number`);
      failed++;
      continue;
    }
    
    const images = await fetchCardImages(card.set_code, card.collector_number);
    
    if (images) {
      const { error: updateError } = await supabase
        .from('cards')
        .update(images)
        .eq('id', card.id);
      
      if (updateError) {
        console.log(`\n❌ Failed to update "${card.card_name}": ${updateError.message}`);
        failed++;
      } else {
        updated++;
        process.stdout.write(` ✅`);
      }
    } else {
      console.log(`\n⚠️  No image found for "${card.card_name}" (${card.set_code} #${card.collector_number})`);
      notFound++;
    }
    
    // Rate limiting
    if (i < cards.length - 1) await sleep(RATE_LIMIT_DELAY);
  }
  
  console.log('\n\n✅ Done!');
  console.log(`   Updated: ${updated} cards`);
  console.log(`   Not found: ${notFound} cards`);
  console.log(`   Failed: ${failed} cards`);
}

main().catch(console.error);
