// Deterministic, non-mutating regression checks for the candidate build guard.
// No Next build, server, browser, fixture, or database is involved.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptPath = fileURLToPath(new URL('./phase45c-build-isolated-candidate.mjs', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbb-phase45c-build-guard-'))
const source = path.join(root, 'source')
const candidate = path.join(root, 'candidate')
const candidateScript = path.join(candidate, 'scripts', path.basename(scriptPath))

function makePackage(dir) {
  fs.mkdirSync(path.join(dir, '.next'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n')
}

function run(cwd, { port = '3100', env: extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [candidateScript,
    '--source', source, '--candidate', candidate, '--port', port, '--verify-only'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3100',
      ...extraEnv,
    },
  })
}

try {
  makePackage(source)
  makePackage(candidate)
  fs.writeFileSync(path.join(source, '.next', 'BUILD_ID'), 'protected-source-build\n')
  fs.copyFileSync(scriptPath, candidateScript)
  const protectedBuild = fs.readFileSync(path.join(source, '.next', 'BUILD_ID'), 'utf8')

  const wrongDirectory = run(source)
  assert.notEqual(wrongDirectory.status, 0, 'source CWD must be refused before a build can run')
  assert.match(wrongDirectory.stderr, /current directory .* is not the declared candidate/)
  assert.equal(fs.readFileSync(path.join(source, '.next', 'BUILD_ID'), 'utf8'), protectedBuild,
    'the wrong-CWD refusal leaves the protected source artifact untouched')

  const admitted = run(candidate)
  assert.equal(admitted.status, 0, admitted.stderr)
  assert.match(admitted.stdout, /"mode":"verify-only"/)
  assert.equal(fs.readFileSync(path.join(source, '.next', 'BUILD_ID'), 'utf8'), protectedBuild,
    'an admitted preflight also leaves the protected source artifact untouched')

  const mismatchedPort = run(candidate, { env: { NEXT_PUBLIC_SITE_URL: 'http://localhost:3000' } })
  assert.notEqual(mismatchedPort.status, 0, 'the app origin must match the isolated server port')
  assert.match(mismatchedPort.stderr, /port 3000 must equal --port 3100/)

  const sharedPort = run(candidate, {
    port: '3000', env: { NEXT_PUBLIC_SITE_URL: 'http://localhost:3000' },
  })
  assert.notEqual(sharedPort.status, 0, 'the shared phone-facing server port must be refused')
  assert.match(sharedPort.stderr, /protected phone-facing service/)
  console.log('4 isolated candidate build-guard checks passed')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
