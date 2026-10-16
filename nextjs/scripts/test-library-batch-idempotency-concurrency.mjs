// Local disposable Supabase SQL concurrency only; no REST/JWT/UAT claim.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

if (!process.argv.includes('--local-runtime')) {
  console.log('BATCH_IDEMPOTENCY_CONCURRENCY: use --local-runtime with the disposable stack')
} else {
  const container = process.env.PHASE45C_DB_CONTAINER || 'supabase_db_dbb-train'
  assert.match(container, /^supabase_db_[a-zA-Z0-9_-]+$/)
  const args = ['exec', '-i', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
  const sql = input => {
    const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 15000 })
    assert.ifError(r.error)
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const user = 'e7000000-0000-4000-8000-000000000001'
  const binder = 'e7100000-0000-4000-8000-000000000001'
  const card = 'e7200000-0000-4000-8000-000000000001'
  const batch = 'e7400000-0000-4000-8000-000000000001'
  const rows = JSON.stringify([{ scryfall_id: card, quantity: 3 }])
  const baseline = process.argv.includes('--baseline')
  const call = baseline ? `public.import_library_cards('${user}','${binder}','${rows}')` :
    `public.import_library_cards_once('${user}','${binder}','${batch}','${rows}')`
  const cleanup = `BEGIN; DELETE FROM public.library_batch_receipts WHERE user_id='${user}';
DELETE FROM public.library_cards WHERE user_id='${user}'; DELETE FROM public.binders WHERE user_id='${user}';
DELETE FROM auth.users WHERE id='${user}'; DELETE FROM public.card_index WHERE scryfall_id='${card}'; COMMIT;`
  let holder, waiter, holderExit, waiterExit, holderOutput = '', waiterOutput = '', errors = ''
  try {
    assert.equal(sql(`SELECT count(*) FROM auth.users WHERE id='${user}'`), '0', 'fixture must be absent')
    sql(`BEGIN; INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${user}','batch-race@dbb.test','{"username":"batch_race"}');
INSERT INTO public.binders(id,user_id,name) VALUES ('${binder}','${user}','Batch race');
INSERT INTO public.card_index(scryfall_id,name,set_code,collector_number) VALUES ('${card}','Batch race fixture','tst','batch-race'); COMMIT;`)
    holder = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    holderExit = once(holder, 'close')
    holder.stdout.on('data', b => { holderOutput += b })
    holder.stderr.on('data', b => { errors += b })
    holder.stdin.write(`SET application_name='batch_once_holder'; SET statement_timeout='10s'; BEGIN;\nSELECT * FROM ${call};\n\\echo BATCH_RECEIPT_HELD\n`)
    for (let n = 0; !holderOutput.includes('BATCH_RECEIPT_HELD') && n < 100; n++) await delay(25)
    assert.ok(holderOutput.includes('BATCH_RECEIPT_HELD'), `holder must acknowledge actual receipt/card acquisition: ${errors}`)
    waiter = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    waiterExit = once(waiter, 'close')
    waiter.stdout.on('data', b => { waiterOutput += b })
    waiter.stderr.on('data', b => { errors += b })
    waiter.stdin.end(`SET application_name='batch_once_waiter'; SET statement_timeout='10s';\nSELECT * FROM ${call};\n`)
    let blocked = false
    for (let n = 0; n < 30 && !blocked; n++) {
      blocked = sql(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h
 ON h.application_name='batch_once_holder' AND h.pid=ANY(pg_blocking_pids(w.pid))
 WHERE w.application_name='batch_once_waiter' AND w.wait_event_type='Lock'
 AND w.query LIKE '%${baseline ? card : batch}%');`) === 't'
      if (!blocked) await delay(30)
    }
    assert.ok(blocked, 'duplicate call must demonstrably wait on the named holder transaction')
    holder.stdin.end('COMMIT;\n')
    const [[holderCode], [waiterCode]] = await Promise.all([holderExit, waiterExit])
    assert.equal(holderCode, 0, errors)
    assert.equal(waiterCode, 0, errors)
    const quantity = Number(sql(`SELECT quantity FROM public.library_cards WHERE user_id='${user}' AND binder_id='${binder}' AND scryfall_id='${card}'`))
    assert.equal(quantity, 3, 'concurrent duplicate must add exactly once (legacy path doubles to 6)')
    assert.match(holderOutput, /^1\|0\|f/m)
    assert.equal(waiterOutput.trim(), '1|0|t', 'waiter returns stored first-write counts')
    assert.equal(sql(`SELECT count(*) FROM public.library_batch_receipts WHERE user_id='${user}' AND batch_id='${batch}'`), '1')
    console.log('BATCH_IDEMPOTENCY_CONCURRENCY_PASS: acquired sentinel, observed exact holder blocking, quantity3, one receipt, waiter replay')
  } finally {
    holder?.stdin.destroy()
    waiter?.stdin.destroy()
    holder?.kill()
    waiter?.kill()
    if (holderExit) await holderExit
    if (waiterExit) await waiterExit
    sql(cleanup)
    assert.equal(sql(`SELECT (SELECT count(*) FROM auth.users WHERE id='${user}')+(SELECT count(*) FROM public.card_index WHERE scryfall_id='${card}')+(SELECT count(*) FROM public.library_batch_receipts WHERE user_id='${user}')`), '0')
    console.log('BATCH_IDEMPOTENCY_CONCURRENCY_CLEANUP_PASS')
  }
}
