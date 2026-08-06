// Phase 46 — computed accessibility gates for the shared accent pairing, the
// price red, and the mobile tab bar.
//
// These are not string greps. The contrast checks read the actual token values
// out of globals.css and recompute the WCAG 2.x relative-luminance ratio, so a
// future change to the accent red fails here the moment it drops below the AA
// floor — which is exactly how the shipped 3.55:1 `.btn-primary` pairing
// survived every previous review (DBB has historically caught contrast bugs by
// eye during UAT, never mechanically).

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const SRC_ROOT = new URL('../src/', import.meta.url)
const css = fs.readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
const navSource = fs.readFileSync(new URL('../src/components/DBBNav.js', import.meta.url), 'utf8')
const tailwindConfig = fs.readFileSync(new URL('../tailwind.config.js', import.meta.url), 'utf8')

// WCAG 2.x contrast: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
function channel(v) {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function relativeLuminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
function parseHex(hex) {
  const h = hex.replace('#', '')
  assert.equal(h.length, 6, `expected a 6-digit hex, got "${hex}"`)
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}

// `:root` is the single source of truth; read it rather than any later override.
const root = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-reduced-motion: reduce)'))
function readToken(name) {
  const m = root.match(new RegExp(`--${name}:\\s*([^;]+);`))
  assert.ok(m, `token --${name} not found in :root`)
  return m[1].trim()
}

const WHITE = [255, 255, 255]
const AA_NORMAL_TEXT = 4.5

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.message}`)
    failed += 1
  }
}

check('the accent and price hex/rgb tokens describe the same colour', () => {
  for (const [hexToken, rgbToken] of [
    ['dbb-accent', 'dbb-accent-rgb'],
    ['dbb-accent-hov', 'dbb-accent-hov-rgb'],
    ['dbb-price', 'dbb-price-rgb'],
  ]) {
    const fromHex = parseHex(readToken(hexToken))
    const fromRgb = readToken(rgbToken).split(/\s+/).map(Number)
    assert.deepEqual(
      fromRgb, fromHex,
      `--${rgbToken} (${fromRgb.join(' ')}) must match --${hexToken} (${fromHex.join(' ')}); ` +
      'Tailwind utilities read the rgb triple and plain CSS reads the hex, so a drift ' +
      'silently ships two different accent reds'
    )
  }
})

check('every red paired with white meets WCAG AA for normal-size text', () => {
  // The contrast ratio is symmetric, so one computation covers both pairings:
  // white text on an accent fill, and price text on a white surface.
  for (const [token, pairing] of [
    ['dbb-accent', '#FFFFFF text on the accent fill'],
    ['dbb-accent-hov', '#FFFFFF text on the hover fill'],
    ['dbb-price', 'price text on the #FFFFFF card surface'],
  ]) {
    const value = readToken(token)
    const ratio = contrastRatio(parseHex(value), WHITE)
    assert.ok(
      ratio >= AA_NORMAL_TEXT,
      `${pairing}: var(--${token}) = ${value} measures ${ratio.toFixed(3)}:1, ` +
      `below the ${AA_NORMAL_TEXT}:1 AA floor for normal-size text`
    )
    console.log(`       var(--${token}) = ${value} → ${ratio.toFixed(3)}:1 vs #FFFFFF (${pairing})`)
  }
})

check('.btn-primary is still white-on-accent at a size with no large-text exemption', () => {
  const btnPrimary = css.slice(css.indexOf('.btn-primary {'), css.indexOf('.btn-secondary {'))
  assert.match(btnPrimary, /background-color:\s*var\(--dbb-accent\)/, '.btn-primary must fill with the accent token')
  assert.match(btnPrimary, /color:\s*white/, '.btn-primary must use white text')
  assert.match(btnPrimary, /background-color:\s*var\(--dbb-accent-hov\)/, '.btn-primary:hover must fill with the hover token')

  // WCAG's 3:1 large-text allowance starts at 24px normal or 18.66px bold. If
  // `.btn` ever grew past that this gate would become vacuous, so assert it has
  // not: the 4.5:1 floor above only binds while the button is small text.
  const btn = css.slice(css.indexOf('.btn {'), css.indexOf('.btn:active'))
  const size = btn.match(/font-size:\s*([\d.]+)rem/)
  const weight = btn.match(/font-weight:\s*(\d+)/)
  assert.ok(size, '.btn must declare an explicit font-size')
  assert.ok(weight, '.btn must declare an explicit font-weight')
  const px = Number(size[1]) * 16
  const bold = Number(weight[1]) >= 700
  assert.ok(
    bold ? px < 18.66 : px < 24,
    `.btn renders at ${px}px/${weight[1]}, which qualifies for WCAG's large-text ` +
    'exemption — the 4.5:1 assertion above no longer describes the real requirement'
  )
  console.log(`       .btn renders at ${px}px / weight ${weight[1]} → normal-text thresholds apply`)
})

// The 4.5:1 assertion on --dbb-price above only describes the real requirement
// while price text is *small* text. Resolve every rendered price usage to a real
// px size and weight and prove none of them qualifies for WCAG's large-text
// exemption — otherwise the AA check silently becomes vacuous.
const DBB_FONT_SIZES = (() => {
  const block = tailwindConfig.slice(tailwindConfig.indexOf('fontSize: {'))
  const sizes = new Map()
  for (const [, name, px] of block.slice(0, block.indexOf('}')).matchAll(/'([\w-]+)':\s*'(\d+)px'/g)) {
    sizes.set(`text-${name}`, Number(px))
  }
  return sizes
})()
// Tailwind's own defaults, for price surfaces that use the stock scale.
const STOCK_FONT_SIZES = new Map(Object.entries({
  'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18,
  'text-xl': 20, 'text-2xl': 24, 'text-3xl': 30, 'text-4xl': 36,
}))
const FONT_WEIGHTS = new Map(Object.entries({
  'font-thin': 100, 'font-extralight': 200, 'font-light': 300, 'font-normal': 400,
  'font-medium': 500, 'font-semibold': 600, 'font-bold': 700,
  'font-extrabold': 800, 'font-black': 900,
}))

function sourceFiles(dir) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(child))
    else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) found.push(child)
  }
  return found.sort()
}

check('every rendered price surface is small text, so the 4.5:1 floor binds', () => {
  const resolved = []
  for (const file of sourceFiles(new URL(SRC_ROOT).pathname)) {
    const source = fs.readFileSync(file, 'utf8')
    const total = [...source.matchAll(/text-dbb-price/g)].length
    if (total === 0) continue
    const literals = [...source.matchAll(/className="([^"]*\btext-dbb-price\b[^"]*)"/g)].map(m => m[1])
    // Fail closed: a template literal or computed class would slip past the
    // size resolution below and leave an unmeasured price surface shipping.
    assert.equal(
      literals.length, total,
      `${path.relative(process.cwd(), file)} has ${total} text-dbb-price usage(s) but ` +
      `${literals.length} resolvable plain className literal(s); this gate cannot size the rest`
    )
    for (const className of literals) {
      const classes = className.split(/\s+/)
      const sizeClass = classes.find(c => DBB_FONT_SIZES.has(c) || STOCK_FONT_SIZES.has(c) || /^text-\[\d+px\]$/.test(c))
      assert.ok(
        sizeClass,
        `${path.relative(process.cwd(), file)}: price element "${className}" declares no ` +
        'resolvable font size, so its large-text status cannot be proven'
      )
      const px = DBB_FONT_SIZES.get(sizeClass) ?? STOCK_FONT_SIZES.get(sizeClass) ?? Number(sizeClass.match(/\d+/)[0])
      const weightClass = classes.find(c => FONT_WEIGHTS.has(c))
      const weight = weightClass ? FONT_WEIGHTS.get(weightClass) : 400
      const bold = weight >= 700
      assert.ok(
        bold ? px < 18.66 : px < 24,
        `${path.relative(process.cwd(), file)}: price text renders at ${px}px/${weight}, which ` +
        "qualifies for WCAG's large-text exemption — the 4.5:1 assertion on --dbb-price " +
        'no longer describes the real requirement for it'
      )
      resolved.push(`${path.basename(file)} ${px}px/${weight}`)
    }
  }
  // The standing DBB constraint is that pricing is always visibly shown; these
  // are the two card faces that carry it, and both must keep the price token.
  assert.ok(
    resolved.some(entry => entry.startsWith('LibraryCard.js')) &&
    resolved.some(entry => entry.startsWith('BazaarCard.js')),
    'the library and bazaar card faces must both still render a --dbb-price price row; ' +
    `resolved surfaces were: ${resolved.join(', ') || 'none'}`
  )

  // `.price-red` sets the price colour with no size of its own, so it can never
  // claim the exemption statically — but it must not become bold-and-large by
  // growing a size later without passing back through this gate.
  const priceRed = css.slice(css.indexOf('.price-red {'), css.indexOf('}', css.indexOf('.price-red {')))
  assert.match(priceRed, /color:\s*var\(--dbb-price\)/, '.price-red must colour with the price token')
  assert.doesNotMatch(priceRed, /font-size:/, '.price-red must stay size-inheriting, or be sized here')
  console.log(`       price surfaces: ${resolved.join(', ')}; .price-red inherits its size`)
})

check('the mobile tab bar labels clear the 11px functional-text floor', () => {
  // This bar is `sm:hidden`, i.e. it *is* the navigation below Tailwind's 640px
  // breakpoint — real phone widths, DBB's primary audience.
  const tabBar = navSource.slice(navSource.indexOf('function TabBarLink'), navSource.indexOf('export default function DBBNav'))
  assert.ok(tabBar.length > 0, 'TabBarLink component not found')
  const labelSizes = [...tabBar.matchAll(/text-\[(\d+)px\]/g)].map(m => Number(m[1]))
  assert.ok(labelSizes.length > 0, 'TabBarLink must set an explicit label size')
  for (const px of labelSizes) {
    assert.ok(px >= 11, `TabBarLink renders ${px}px text; the functional-text floor is 11px`)
  }
  assert.match(tabBar, /text-\[11px\][\s\S]{0,240}\{label\}/, 'the tab label span must carry the checked size')
  assert.match(
    navSource,
    /className="sm:hidden fixed bottom-0/,
    'the tab bar must remain the sub-640px navigation this gate assumes'
  )
  console.log(`       TabBarLink explicit sizes: ${labelSizes.map(p => `${p}px`).join(', ')}`)
})

if (failed) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll contrast and legibility checks passed.')
