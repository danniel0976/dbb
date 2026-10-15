import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cli = new URL('./verify-provenance.mjs', import.meta.url).pathname;
const allowlist = { version: 1, hosts: [
  { hostname: 'chippy-vps', aliases: [], fingerprint: 'a682ce31ebeb', roles: ['executor'] },
  { hostname: 'dans-macbook-air', aliases: ['Dans-MacBook-Air-9.local'], fingerprint: '74a2043dcfd4', roles: ['publisher'] },
] };
const trailers = 'Executed-On: chippy-vps\nHost-Role: executor\nHost-Fingerprint: a682ce31ebeb\nNonce: 0123456789abcdef';

function fixture(t) {
  const root = mkdtempSync(`${tmpdir()}/provenance-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => {
    const r = spawnSync('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'Base');
  const base = git('rev-parse', 'HEAD');
  const hosts = `${root}/hosts.json`;
  writeFileSync(hosts, JSON.stringify(allowlist));
  const bin = `${root}/bin`;
  mkdirSync(bin);
  // Guard every actual verifier subprocess: no network-capable/write Git commands,
  // no shell, fixed executable, fixture-only cwd. Node itself is permission-confined.
  writeFileSync(`${bin}/git`, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(process.cwd(), ${JSON.stringify(root)});
assert.deepEqual(args.slice(0, 5), ['--no-pager', 'log', '--no-show-signature', '--no-notes', '--format=%H%x00%(trailers:only,unfold)']);
assert.equal(args[5], '-z');
assert.match(args[6], /^[A-Za-z0-9_./~^@{}-]+\\.\\.\\.?[A-Za-z0-9_./~^@{}-]+$/);
assert.equal(args[7], '--');
assert.equal(args.length, 8);
appendFileSync(${JSON.stringify(`${root}/commands.jsonl`)}, JSON.stringify(args) + '\\n');
const r = spawnSync('/usr/bin/git', args, { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const permissions = ['--permission', `--allow-fs-read=${cli}`, `--allow-fs-read=${root}`,
    `--allow-fs-write=${root}`, '--allow-child-process'];
  const run = (...args) => spawnSync(process.execPath, [...permissions, cli, ...args], {
    cwd: root, env: { ...env, PATH: bin }, encoding: 'utf8',
  });
  const commit = (body) => git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', body);
  const verify = () => run('--verify', `${base}..HEAD`, '--hosts', hosts);
  return { root, hosts, base, run, commit, verify, permissions };
}

for (const [name, body, error] of [
  ['missing trailers', 'Bad', 'Executed-On'],
  ['wrong host', `Bad\n\n${trailers.replace('chippy-vps', 'unknown-host')}`, 'host'],
  ['forged fingerprint', `Bad\n\n${trailers.replace('a682ce31ebeb', '000000000000')}`, 'fingerprint'],
  ['duplicate trailers', `Bad\n\n${trailers}\nExecuted-On: chippy-vps`, 'Executed-On'],
  ['role mismatch', `Bad\n\n${trailers.replace('executor', 'publisher')}`, 'role'],
  ['malformed nonce', `Bad\n\n${trailers.replace('0123456789abcdef', 'not-hex')}`, 'nonce'],
  ['body-only trailers', `Bad\n\n${trailers}\n\nNot a trailer block.`, 'Executed-On'],
  ['case-insensitive duplicate', `Bad\n\n${trailers}\nhost-role: executor`, 'Host-Role'],
  ['missing fingerprint', `Bad\n\n${trailers.replace('Host-Fingerprint: a682ce31ebeb\n', '')}`, 'Host-Fingerprint'],
  ['missing nonce', `Bad\n\n${trailers.replace('\nNonce: 0123456789abcdef', '')}`, 'Nonce'],
  ['missing role', `Bad\n\n${trailers.replace('Host-Role: executor\n', '')}`, 'Host-Role'],
]) {
  test(name, (t) => {
    const f = fixture(t);
    f.commit(`Good\n\n${trailers}`);
    assert.equal(f.verify().status, 0, f.verify().stderr);
    f.commit(body);
    const r = f.verify();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /PASS/);
    assert.match(r.stdout, new RegExp(`FAIL.*${error}`, 'i'));
  });
}

test('good commit, publisher alias, and confined actual commands', (t) => {
  const f = fixture(t);
  f.commit(`Good\n\n${trailers}\nPilot-Task: pilot-002`);
  f.commit(`Publisher\n\n${trailers.replace('chippy-vps', 'Dans-MacBook-Air-9.local')
    .replace('executor', 'publisher').replace('a682ce31ebeb', '74a2043dcfd4')}`);
  const r = f.verify();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.match(/PASS/g)?.length, 2);
  assert.equal(readFileSync(`${f.root}/commands.jsonl`, 'utf8').trim().split('\n').length, 1);
  const probe = spawnSync(process.execPath, [...f.permissions, '-e',
    `const fs = require('node:fs');
     require('node:assert/strict').equal(process.permission.has('net'), false);
     require('node:assert/strict').throws(() => fs.writeFileSync('/root/dbb-twin/evidence/forbidden-probe', 'x'), { code: 'ERR_ACCESS_DENIED' });
     console.log('network denied; outside writes denied');`], { cwd: f.root, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /network denied; outside writes denied/);
});

test('missing, invalid, nonexistent, empty ranges and misuse fail closed', (t) => {
  const f = fixture(t);
  f.commit(`Good\n\n${trailers}`);
  assert.equal(f.verify().status, 0);
  for (const args of [[], ['--verify'], ['--verify', 'HEAD'], ['--verify', '--all'],
    ['--verify', 'missing..HEAD'], ['--verify', 'HEAD..HEAD'], ['--verify', 'HEAD..HEAD', '--bogus'],
    ['--print-identity', '--trailer'], ['--trailer', '--hosts', f.hosts]]) {
    const r = f.run(...args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.match(r.stderr, /Error:/);
  }
});

test('invalid allowlist and unavailable identity fail closed', (t) => {
  const f = fixture(t);
  f.commit(`Good\n\n${trailers}`);
  assert.equal(f.verify().status, 0);
  writeFileSync(f.hosts, JSON.stringify({ version: 1, hosts: [allowlist.hosts[0], allowlist.hosts[0]] }));
  assert.equal(f.verify().status, 1);
  for (const mode of ['--print-identity', '--trailer']) {
    const r = f.run(mode); // /etc/machine-id is intentionally not readable here.
    assert.equal(r.status, 1);
    assert.match(r.stderr, /identity unavailable/i);
    assert.equal(r.stdout, '');
  }
});

test('VPS identity and trailer output under read-only Node confinement', (t) => {
  const f = fixture(t);
  const run = (mode) => spawnSync(process.execPath, ['--permission', `--allow-fs-read=${cli}`,
    '--allow-fs-read=/etc/machine-id', cli, mode], { cwd: f.root, encoding: 'utf8' });
  const result = run('--print-identity');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { hostname: 'chippy-vps', platform: 'linux', fingerprint: 'a682ce31ebeb' });
  const first = run('--trailer');
  const second = run('--trailer');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /^Executed-On: chippy-vps\nHost-Role: executor\nHost-Fingerprint: a682ce31ebeb\nNonce: [a-f0-9]{32}\n$/);
  assert.notEqual(first.stdout, second.stdout);
});
