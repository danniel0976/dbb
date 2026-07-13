import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/components/CameraCapture.js', import.meta.url), 'utf8')
const checks = [
  ['portrait viewport uses exact 63:88 ratio', source.includes("data-testid=\"portrait-camera-viewport\"") && source.includes("aspectRatio: '63 / 88'")],
  ['visible guide uses exact 63:88 ratio', source.includes("data-testid=\"mtg-framing-guide\"") && source.includes("border: '3px dashed rgba(255, 255, 255, 0.9)'")],
  ['guide center is not obscured by a full-screen tint', !source.includes('absolute inset-0 bg-black/30')],
  ['landscape sensor output is center-cropped to portrait', source.includes('vw / vh > MTG_CARD_RATIO') && source.includes('drawImage(video, sx, sy, sw, sh, 0, 0, w, h)')],
  ['preview preserves portrait ratio', source.includes("maxWidth: '420px', aspectRatio: '63 / 88'")],
]

let failed = 0
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) failed += 1
}
if (failed) process.exit(1)
