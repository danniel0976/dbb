// Complete identity expansion is separate from bounded fuzzy name discovery.
export function catalogImage(card) {
  return card?.image_uris || card?.card_faces?.find(face => face.image_uris)?.image_uris || null
}
export function preferPrintings(editions, options = {}) {
  const language = options.language || 'en'
  const key = e => [
    e.scryfall_id === options.preferredId ? 1 : 0,
    options.setLock && e.set_code === options.setLock ? 1 : 0,
    options.lastSet && e.set_code === options.lastSet ? 1 : 0,
    options.setCode && options.collectorNumber && e.set_code === options.setCode && String(e.collector_number).replace(/^0+(?=\d)/,'') === String(options.collectorNumber).replace(/^0+(?=\d)/,'') ? 1 : 0,
    e.lang === language ? 1 : 0,
    e.lang || '',
    !e.digital && !e.promo && e.set_type !== 'art_series' && !e.frame_effects?.includes('showcase') && (!e.games || e.games.includes('paper')) ? 1 : 0,
    e.released_at || '',
  ]
  return [...editions].sort((a,b) => {
    const ka=key(a),kb=key(b)
    for(let i=0;i<ka.length;i++) if(ka[i]!==kb[i]) return ka[i]>kb[i]?-1:1
    return String(a.scryfall_id).localeCompare(String(b.scryfall_id))
  })
}
export async function printingPage(query, {name, cursor = '', limit = 40, ...preferences}) {
  // Keyset walk through the exact identity, with no 600-row fuzzy cap. Fail the
  // whole read on an error: a partial family must not masquerade as complete.
  const rows=[]; let after=''
  for(;;) {
    const {data,error}=await query(after,200)
    if(error) throw new Error('Printing lookup failed')
    const page=data||[]
    rows.push(...page)
    if(page.length<200) break
    const next=page.at(-1)?.scryfall_id
    if(!next || next===after) throw new Error('Invalid printing cursor')
    after=next
  }
  const ordered=preferPrintings(rows,preferences)
  const offset=cursor ? ordered.findIndex(e=>e.scryfall_id===cursor)+1 : 0
  if(cursor && !offset) throw new Error('Printing list changed; reopen it')
  const slice=ordered.slice(offset,offset+limit)
  const groups=[{name,editions:slice.map(e=>({...e,image_uris:catalogImage(e)}))}]
  return {groups,total:ordered.length,has_more:offset+slice.length<ordered.length,next_cursor:offset+slice.length<ordered.length?slice.at(-1)?.scryfall_id:null}
}
