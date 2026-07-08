#!/usr/bin/env python3
"""
Build CK URL cache from MTGJSON AllPrintings using streaming decompression
and incremental JSON parsing (avoid 610MB string in memory).
"""

import gzip
import json
import urllib.request
import os
import sys
import re

MTGJSON_URL = 'https://mtgjson.com/api/v5/AllPrintings.json.gz'
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'ck-urls.json')

def stream_download_and_parse():
    print('📥 Downloading and parsing AllPrintings from MTGJSON...')
    
    tmp_path = OUTPUT + '.tmp.gz'
    
    # Download
    req = urllib.request.Request(MTGJSON_URL, headers={'User-Agent': 'DBB-Backfill/1.0'})
    with urllib.request.urlopen(req) as resp:
        total = int(resp.headers.get('content-length', 0))
        print(f'   Size: {total / 1024 / 1024:.1f}MB compressed')
        downloaded = 0
        with open(tmp_path, 'wb') as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
    
    # Decompress and extract just what we need using regex-based parsing
    # This avoids loading the entire 610MB JSON into memory
    print('   Decompressing and extracting CK URLs...')
    
    url_map = {}
    total_cards = 0
    with_ck = 0
    
    # Process in chunks - decompress and search for card objects
    import io
    with gzip.open(tmp_path, 'rt', encoding='utf-8') as f:
        in_card = False
        card_depth = 0
        current_sf_id = None
        current_ck_url = None
        current_ck_foil_url = None
        current_ck_id = None
        current_key = None
        in_identifiers = 0
        in_purchase = 0
        
        for line in f:
            line = line.strip()
            
            # Track scryfallId
            if '"scryfallId"' in line:
                m = re.search(r'"scryfallId"\s*:\s*"([^"]+)"', line)
                if m:
                    current_sf_id = m.group(1).lower()
            
            # Track cardKingdomId in identifiers
            if '"cardKingdomId"' in line and in_identifiers > 0:
                m = re.search(r'"cardKingdomId"\s*:\s*"([^"]+)"', line)
                if m:
                    current_ck_id = m.group(1)
            
            # Track identifiers scope
            if '"identifiers"' in line and '{' in line:
                in_identifiers += 1
            if in_identifiers > 0 and '}' in line and '{' not in line:
                in_identifiers -= 1
            
            # Track purchaseUrls
            if '"purchaseUrls"' in line and '{' in line:
                in_purchase += 1
            
            if in_purchase > 0:
                if '"cardKingdomFoil"' in line:
                    m = re.search(r'"cardKingdomFoil"\s*:\s*"([^"]+)"', line)
                    if m:
                        current_ck_foil_url = m.group(1)
                elif '"cardKingdom"' in line and 'Foil' not in line:
                    m = re.search(r'"cardKingdom"\s*:\s*"([^"]+)"', line)
                    if m:
                        current_ck_url = m.group(1)
            
            if '"purchaseUrls"' in line and '}' in line and '{' not in line:
                in_purchase -= 1
            
            # End of card object - save if we have data
            # We detect end of card by seeing a closing brace at the right depth
            # This is fragile, so let's use a simpler approach
    
    os.unlink(tmp_path)
    print('   (Regex approach too fragile, switching to full parse...)')

def full_parse():
    """Download, decompress, and parse with Python's json module.
    Uses temp file to avoid string-length limits."""
    print('📥 Downloading AllPrintings from MTGJSON...')
    
    tmp_gz = OUTPUT + '.tmp.gz'
    tmp_json = OUTPUT + '.tmp.json'
    
    # Download
    req = urllib.request.Request(MTGJSON_URL, headers={'User-Agent': 'DBB-Backfill/1.0'})
    with urllib.request.urlopen(req) as resp:
        total = int(resp.headers.get('content-length', 0))
        print(f'   Size: {total / 1024 / 1024:.1f}MB compressed')
        downloaded = 0
        with open(tmp_gz, 'wb') as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                print(f'\r   Downloaded: {downloaded / 1024 / 1024:.1f}MB', end='', flush=True)
    print()
    
    # Decompress
    print('   Decompressing...')
    with gzip.open(tmp_gz, 'rb') as gz:
        with open(tmp_json, 'wb') as out:
            while True:
                chunk = gz.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
    os.unlink(tmp_gz)
    
    json_size = os.path.getsize(tmp_json)
    print(f'   Decompressed: {json_size / 1024 / 1024:.1f}MB')
    
    if json_size > 500 * 1024 * 1024:  # > 500MB
        print('   ⚠️  Large file, using incremental parse...')
        incremental_parse(tmp_json)
    else:
        print('   Parsing JSON...')
        with open(tmp_json, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        url_map = {}
        total_cards = 0
        with_ck = 0
        
        sets = data.get('data', data)
        for set_code, set_data in sets.items():
            for card in set_data.get('cards', []):
                total_cards += 1
                sf_id = (card.get('identifiers', {}) or {}).get('scryfallId', '').lower()
                if not sf_id:
                    continue
                
                purchase_urls = card.get('purchaseUrls', {}) or {}
                identifiers = card.get('identifiers', {}) or {}
                
                ck_url = purchase_urls.get('cardKingdom')
                ck_foil_url = purchase_urls.get('cardKingdomFoil')
                ck_id = identifiers.get('cardKingdomId')
                
                if ck_url or ck_id:
                    with_ck += 1
                    url_map[sf_id] = {
                        'ck_url': ck_url or (f'https://www.cardkingdom.com/mtg-singles/product/{ck_id}' if ck_id else None),
                        'ck_foil_url': ck_foil_url,
                        'ck_id': ck_id,
                    }
        
        save_results(url_map, total_cards, with_ck)
    
    # Cleanup
    if os.path.exists(tmp_json):
        os.unlink(tmp_json)

def incremental_parse(json_path):
    """Parse large JSON file incrementally using ijson-like approach."""
    # For very large files, use subprocess with Node.js which handles large JSON better
    print('   Using Node.js for large JSON parsing...')
    
    import subprocess
    result = subprocess.run([
        'node', '-e', '''
const fs = require('fs');
const path = require('path');
const { createGunzip } = require('zlib');

const jsonPath = process.argv[1];
console.log('   Reading JSON file...');

// Read in chunks and parse
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const sets = data.data || data;
const urlMap = {};
let totalCards = 0;
let withCk = 0;

for (const [setCode, setData] of Object.entries(sets)) {
  for (const card of (setData.cards || [])) {
    totalCards++;
    const sfId = (card.identifiers?.scryfallId || '').toLowerCase();
    if (!sfId) continue;
    
    const ckUrl = card.purchaseUrls?.cardKingdom;
    const ckFoilUrl = card.purchaseUrls?.cardKingdomFoil;
    const ckId = card.identifiers?.cardKingdomId;
    
    if (ckUrl || ckId) {
      withCk++;
      urlMap[sfId] = {
        ck_url: ckUrl || (ckId ? `https://www.cardkingdom.com/mtg-singles/product/${ckId}` : null),
        ck_foil_url: ckFoilUrl || null,
        ck_id: ckId || null,
      };
    }
  }
}

// Output as JSONL for easy parsing
process.stdout.write(JSON.stringify({ totalCards, withCk, uniqueIds: Object.keys(urlMap).length }));
process.stdout.write('\\n');
process.stdout.write(JSON.stringify(urlMap));
''', json_path], capture_output=True, text=True)
    
    if result.returncode !== 0:
        print(f'   ❌ Node.js parsing failed: {result.stderr}')
        sys.exit(1)
    
    lines = result.stdout.strip().split('\n')
    meta = json.loads(lines[0])
    url_map = json.loads(lines[1])
    
    save_results(url_map, meta['totalCards'], meta['withCk'])

def save_results(url_map, total_cards, with_ck):
    output = {
        '_meta': {
            'built': __import__('datetime').datetime.now().isoformat(),
            'totalCards': total_cards,
            'withCkUrl': with_ck,
            'uniqueScryfallIds': len(url_map),
        },
        'urls': url_map,
    }
    
    with open(OUTPUT, 'w') as f:
        json.dump(output, f)
    
    print(f'\n✅ Saved to {OUTPUT}')
    print(f'   File size: {os.path.getsize(OUTPUT) / 1024 / 1024:.1f}MB')
    print(f'   Total cards: {total_cards}')
    print(f'   With CK URL/ID: {with_ck}')
    print(f'   Unique Scryfall IDs: {len(url_map)}')

if __name__ == '__main__':
    full_parse()