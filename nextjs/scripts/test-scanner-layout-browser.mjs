// Offline rendered-layout test. Requires admitted dependencies + cached browser;
// never downloads a browser, starts a backend, or requests real camera access.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const app = fileURLToPath(new URL('../', import.meta.url))
assert.equal(process.cwd()+'/',app,'run from the candidate nextjs directory')
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright')
const output = mkdtempSync(join(process.env.TMPDIR || tmpdir(),'scanner-layout-'))
const compiled = require('next/dist/compiled/webpack/webpack'); compiled.init()
await new Promise((resolve,reject) => compiled.webpack({mode:'development',target:'web',entry:join(app,'scripts/scanner-layout/entry.js'),output:{path:output,filename:'bundle.js'},resolve:{alias:{'@':join(app,'src')},modules:[join(app,'node_modules'),'node_modules'],extensions:['.js','.mjs','.json']},module:{rules:[{test:/\.js$/,exclude:/node_modules/,use:[join(app,'scripts/scanner-layout/jsx-loader.cjs')]}]},plugins:[new compiled.webpack.DefinePlugin({'process.env':JSON.stringify({})})],devtool:false},(err,stats)=>err||stats.hasErrors()?reject(err||new Error(stats.toString({all:false,errors:true}))):resolve()))
execFileSync(process.execPath,[require.resolve('tailwindcss/lib/cli.js'),'-i','src/app/globals.css','-o',join(output,'style.css')],{cwd:app,stdio:'pipe'})
const server = createServer((req,res) => {
  if (req.url==='/bundle.js'||req.url==='/style.css') {res.setHeader('Content-Type',req.url.endsWith('.js')?'application/javascript':'text/css');res.end(readFileSync(join(output,req.url.slice(1))));return}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div style="height:100dvh;transform:translateY(45px)" id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
let browser
const results=[]
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.SCANNER_BROWSER_EXECUTABLE})
  const page=await browser.newPage({viewport:{width:390,height:844}})
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort())
  await page.addInitScript(()=>{Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{const canvas=document.createElement('canvas');canvas.width=360;canvas.height=500;const c=canvas.getContext('2d');c.fillStyle='#27394a';c.fillRect(0,0,360,500);c.strokeStyle='white';c.strokeRect(15,15,330,470);return canvas.captureStream(5)}}})})
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'Scan card',exact:true}).click()
  await page.locator('[data-scanner-shell]').waitFor()
  assert.equal(await page.locator('[data-scanner-shell]').evaluate(e=>e.parentElement===document.body),true,'actual modal escapes transformed ancestors')
  assert.equal(await page.locator('body').evaluate(e=>e.style.overflow),'hidden')
  for (const size of [{width:844,height:390},{width:390,height:530}]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(40)
    const shell=await page.locator('[data-scanner-shell]').boundingBox()
    assert.ok(Math.abs(shell.height-size.height)<=1,'actual shell tracks visual viewport height')
    assert.ok(Math.abs(shell.width-size.width)<=1,'actual shell tracks visual viewport width')
    const camera=await page.locator('[data-scanner-camera]').boundingBox(),tray=await page.locator('[data-scanner-tray]').boundingBox()
    assert.ok(camera.y+camera.height<=tray.y+1,'actual modal camera/tray do not overlap on resize')
  }
  await page.setViewportSize({width:390,height:844})
  await page.getByRole('button',{name:'Close',exact:true}).focus();await page.keyboard.press('Shift+Tab')
  assert.equal(await page.locator('[role=dialog]').evaluate(e=>e.contains(document.activeElement)),true,'focus remains inside scanner')
  await page.getByRole('button',{name:'Use manual search'}).click()
  assert.equal(await page.locator('[data-scanner-shell]').count(),0,'manual search returns to original drawer')
  await page.getByRole('button',{name:'Close',exact:true}).click()
  assert.equal(await page.locator('body').evaluate(e=>e.style.overflow),'','close restores body scroll')
  for(const size of [{width:390,height:844},{width:844,height:390},{width:320,height:320}]) {
    await page.setViewportSize(size)
    for(const rows of [0,1,20]) {
      await page.evaluate(n=>window.renderPanel(n),rows);await page.locator('[data-scanner-tray]').waitFor()
      const rect=s=>page.locator(s).evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}})
      const camera=await rect('[data-scanner-camera]'),guide=await rect('[data-scanner-guide]'),tray=await rect('[data-scanner-tray]')
      assert.ok(camera.bottom<=tray.y+1,'camera cannot overlap tray');assert.ok(tray.height>20,'tray stays reachable');assert.ok(tray.bottom<=size.height+1,'tray stays inside viewport')
      await page.locator('[data-scanner-tray]').evaluate(e=>e.scrollTop=e.scrollHeight);await page.waitForTimeout(40)
      assert.deepEqual(await rect('[data-scanner-camera]'),camera,'scroll cannot shift camera');assert.deepEqual(await rect('[data-scanner-guide]'),guide,'scroll cannot shift guide')
      for(const button of await page.locator('button').all()) assert.ok((await button.boundingBox()).height>=44,'44px controls')
      results.push({...size,rows,camera,tray})
    }
  }
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.renderPanel(20));await page.waitForTimeout(50)
  assert.equal(await page.getByText('Printing unverified', {exact:true}).count(),1,'assumed printing is visible')
  assert.equal(await page.getByRole('button',{name:/Change printing/}).count(),20,'each row has a printing editor')
  assert.equal(await page.getByRole('button',{name:'Undo shelf edit'}).count(),1,'Undo is reachable')
  await page.locator('[data-scanner-tray]').evaluate(e=>e.scrollTop=0)
  await page.waitForTimeout(40)
  assert.ok(await page.getByText('Printing unverified',{exact:true}).isVisible(),'unverified badge is reachable at the top of the shelf')
  await page.screenshot({path:join(output,'rendered.png')})
  writeFileSync(join(output,'results.json'),JSON.stringify({pass:true,cases:results,modalPortalFocusManualClose:true},null,2))
  console.log(`SCANNER_BROWSER_PASS ${results.length} layout cases + actual modal portal/focus/manual/close; evidence ${output}`)
} finally {await browser?.close();await new Promise(r=>server.close(r))}
