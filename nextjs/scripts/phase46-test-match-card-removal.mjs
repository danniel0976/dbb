// Source-only retirement guard: no dependencies, app calls, or database access.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const extensions = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']
const excluded = new Set([
  'node_modules', '.next', 'out', 'dist', 'build', 'coverage',
  'generated', '__generated__', 'fixtures', '__fixtures__',
])
const retired = 'nextjs/src/app/api/match-card'
const builder = 'nextjs/scripts/build-card-hashes.mjs'
const endpoint = '/api/match-card'
const repo = fileURLToPath(new URL('../../', import.meta.url))

function walk(dir, visit, exclusions = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (exclusions.has(entry.name)) continue
    const file = path.join(dir, entry.name)
    assert.ok(!entry.isSymbolicLink(), `symlink is not admitted: ${file}`)
    if (entry.isDirectory()) walk(file, visit, exclusions)
    else if (entry.isFile()) visit(file)
  }
}

function audit(root) {
  // Fixed import-relative real root, plus structural anchors and nonzero coverage:
  // a missing/wrong application tree must never pass as an empty scan.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'nextjs/package.json'), 'utf8'))
  assert.equal(manifest.name, 'dans-bizarre-bazaar', 'wrong application root')
  const source = path.join(root, 'nextjs/src')
  for (const anchor of ['app/layout.js', 'middleware.js']) {
    assert.ok(fs.statSync(path.join(source, anchor)).isFile(), `missing source anchor: ${anchor}`)
  }
  const files = []
  walk(source, file => {
    if (extensions.includes(path.extname(file))) files.push(file)
  }, excluded)
  assert.ok(files.length > 0, 'vacuous application source scan')

  // Deliberately NO exclusions or extension filter in the retired directory.
  const directory = path.join(root, retired)
  if (fs.existsSync(directory)) {
    assert.ok(fs.lstatSync(directory).isDirectory(), `retired directory is not a directory: ${retired}`)
    walk(directory, file => assert.fail(`retired directory contains regular file: ${path.relative(root, file)}`))
  }
  assert.ok(!fs.existsSync(path.join(root, builder)), `dead builder remains: ${builder}`)
  for (const file of files) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes(endpoint),
      `literal retired endpoint in application source: ${path.relative(root, file)}`)
  }
  return files.length
}

let checks = 0
function check(label, fn) {
  fn()
  checks += 1
  console.log(`PASS ${label}`)
}

console.log(`Coverage: ${retired} recursively, every regular file, no exclusions; builder absent.`)
console.log(`Caller scan: nextjs/src recursively; extensions ${extensions.join(', ')}.`)
console.log(`Caller exclusions (directory/entry names): ${[...excluded].join(', ')}.`)
console.log('Limitations: literal substring search (including comments); constructed strings are not parsed. Scripts/docs/CI are outside the application caller scan. Symlinks fail closed.')

// Only remove this process's unique fixture directory, never the shared TMPDIR.
const fixture = fs.mkdtempSync(path.join(tmpdir(), 'match-card-removal-'))
function put(relative, text = '') {
  const file = path.join(fixture, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}
function rejectedFile(relative, text, expected) {
  const file = put(relative, text)
  try {
    assert.throws(() => audit(fixture), expected)
  } finally {
    fs.unlinkSync(file)
  }
}

try {
  const manifest = put('nextjs/package.json', JSON.stringify({ name: 'dans-bizarre-bazaar' }))
  put('nextjs/src/app/layout.js', 'export default function Layout() {}\n')
  put('nextjs/src/middleware.js', 'export function middleware() {}\n')
  fs.mkdirSync(path.join(fixture, retired), { recursive: true })
  check('positive clean fixture with empty retired directory', () => assert.equal(audit(fixture), 2))
  for (const name of excluded) {
    for (const extension of extensions) {
      put(`nextjs/src/${name}/ignored${extension}`, `fetch('${endpoint}')\n`)
    }
  }
  check('positive fixture excludes dependencies, generated output, and fixtures for every extension',
    () => assert.equal(audit(fixture), 2))
  for (const extension of extensions) {
    check(`negative re-added route${extension}`, () => {
      rejectedFile(`${retired}/route${extension}`, '', /retired directory contains regular file/)
    })
  }
  check('negative nested arbitrary-extension file even inside an excluded-name directory', () => {
    rejectedFile(`${retired}/node_modules/nested/payload.arbitrary`, '', /retired directory contains regular file/)
  })
  for (const extension of extensions) {
    check(`negative literal caller${extension}`, () => {
      rejectedFile(`nextjs/src/components/Caller${extension}`, `fetch('${endpoint}')\n`, /literal retired endpoint/)
    })
  }
  check('negative re-added dead builder', () => rejectedFile(builder, '', /dead builder remains/))
  check('negative wrong root', () => {
    fs.writeFileSync(manifest, JSON.stringify({ name: 'wrong-root' }))
    try {
      assert.throws(() => audit(fixture), /wrong application root/)
    } finally {
      fs.writeFileSync(manifest, JSON.stringify({ name: 'dans-bizarre-bazaar' }))
    }
  })
  check('negative missing/vacuous source tree', () => {
    const source = path.join(fixture, 'nextjs/src')
    fs.renameSync(source, `${source}-saved`)
    fs.mkdirSync(source)
    try {
      assert.throws(() => audit(fixture), /ENOENT/)
    } finally {
      fs.rmdirSync(source)
      fs.renameSync(`${source}-saved`, source)
    }
  })
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}

check('real repository retirement and application caller scan', () => {
  console.log(`Real-tree coverage: ${audit(repo)} application source files scanned at ${repo}`)
})
console.log(`${checks} checks passed.`)
