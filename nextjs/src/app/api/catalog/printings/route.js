import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabaseServer'
import { printingPage } from '@/lib/scannerPrintings.mjs'
export async function GET(request) {
  const db=await createClient()
  const {data:{user},error}=await db.auth.getUser()
  if(error || !user) return NextResponse.json({error:'Unauthorized'},{status:401})
  const p=new URL(request.url).searchParams
  const name=(p.get('name')||'').trim()
  if(!name || name.length>300) return NextResponse.json({error:'A card identity is required'},{status:400})
  const cursor=p.get('cursor')||''
  if(cursor && !/^[a-f0-9-]{36}$/i.test(cursor)) return NextResponse.json({error:'Invalid printing cursor'},{status:400})
  try {
    const result=await printingPage(async(after,limit)=>{
      let query=db.from('card_index').select('*').eq('catalog_current',true).eq('name',name).order('scryfall_id').limit(limit)
      if(after) query=query.gt('scryfall_id',after)
      return query
    },{name,cursor,preferredId:p.get('preferred')||'',language:p.get('language')||'en',setLock:p.get('set_lock')||'',lastSet:p.get('last_set')||'',setCode:p.get('set')||'',collectorNumber:p.get('collector')||''})
    return NextResponse.json(result)
  } catch { return NextResponse.json({error:'Could not load complete printing choices. Try again.'},{status:503}) }
}
