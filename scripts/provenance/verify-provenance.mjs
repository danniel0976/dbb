import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { hostname, platform } from 'node:os';

// Declared provenance only, NOT cryptographic attestation. Copied allowed fields
// can forge a declaration. Nonces are syntax-checked, not proof or replay protection.
const hex12 = /^[a-f0-9]{12}$/;
const label = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const rangePattern = /^[A-Za-z0-9_./~^@{}-]+\.\.\.?[A-Za-z0-9_./~^@{}-]+$/;
const usage = 'usage: --print-identity | --trailer | --verify <a..b|a...b> [--hosts <file>]';
const fail = (message) => { throw new Error(message); };

function identity() {
  try {
    const system = platform();
    let id;
    if (system === 'linux') {
      id = readFileSync('/etc/machine-id', 'utf8').trim();
      if (!/^[a-fA-F0-9]{32}$/.test(id)) fail('invalid machine identity');
    } else if (system === 'darwin') {
      const result = spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      if (result.error || result.status !== 0) fail('ioreg unavailable');
      id = result.stdout.match(/"IOPlatformUUID"\s*=\s*"([a-fA-F0-9-]{36})"/)?.[1]?.trim();
      if (!id || !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(id)) fail('invalid UUID');
    } else fail('unsupported platform');
    const host = hostname();
    if (!label.test(host)) fail('invalid hostname');
    return { hostname: host, platform: system,
      fingerprint: createHash('sha256').update(`dbb-provenance-v1:${id}`).digest('hex').slice(0, 12) };
  } catch {
    fail('identity unavailable (supported, readable machine identity required)');
  }
}

function loadHosts(path) {
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('cannot read/parse hosts allowlist'); }
  const exact = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj)
    && Object.keys(obj).sort().join(',') === keys.sort().join(',');
  if (!exact(data, ['version', 'hosts']) || data.version !== 1
      || !Array.isArray(data.hosts) || !data.hosts.length) fail('invalid hosts schema');
  const hosts = new Map();
  for (const host of data.hosts) {
    if (!exact(host, ['hostname', 'aliases', 'fingerprint', 'roles'])
        || typeof host.hostname !== 'string' || !label.test(host.hostname)
        || host.hostname !== host.hostname.toLowerCase()
        || typeof host.fingerprint !== 'string' || !hex12.test(host.fingerprint)
        || !Array.isArray(host.aliases) || !Array.isArray(host.roles) || !host.roles.length
        || new Set(host.roles).size !== host.roles.length
        || host.roles.some((role) => !['executor', 'publisher'].includes(role))) fail('invalid host entry');
    for (const name of [host.hostname, ...host.aliases]) {
      if (typeof name !== 'string' || !label.test(name) || hosts.has(name.toLowerCase())) fail('invalid/duplicate host label');
      hosts.set(name.toLowerCase(), host);
    }
  }
  return hosts;
}

function validate(block, hosts) {
  const fields = new Map();
  for (const line of block.split('\n').filter(Boolean)) {
    const match = line.match(/^([^:]+):\s*(.*?)\s*$/);
    if (!match) fail('malformed trailer');
    const key = match[1].trim().toLowerCase();
    fields.set(key, [...(fields.get(key) || []), match[2]]);
  }
  const required = ['Executed-On', 'Host-Role', 'Host-Fingerprint', 'Nonce'];
  const values = required.map((key) => {
    const entries = fields.get(key.toLowerCase());
    if (entries?.length !== 1) fail(`${key}: required exactly once in final trailer block`);
    return entries[0];
  });
  const [name, role, fingerprint, nonce] = values;
  const host = hosts.get(name.toLowerCase());
  if (!label.test(name) || !host) fail('host not allowed');
  if (!hex12.test(fingerprint) || host.fingerprint !== fingerprint) fail('fingerprint mismatch');
  if (!host.roles.includes(role)) fail('role not allowed for host');
  if (!/^(?:[a-f0-9]{2}){8,64}$/.test(nonce)) fail('malformed nonce (16-128 lowercase hex characters, even length required)');
}

function main(args) {
  if (args.length === 1 && ['--print-identity', '--trailer'].includes(args[0])) {
    const id = identity();
    console.log(args[0] === '--print-identity' ? JSON.stringify(id)
      : `Executed-On: ${id.hostname}\nHost-Role: executor\nHost-Fingerprint: ${id.fingerprint}\nNonce: ${randomBytes(16).toString('hex')}`);
    return;
  }
  if (args[0] !== '--verify' || ![2, 4].includes(args.length)
      || (args.length === 4 && (args[2] !== '--hosts' || !args[3] || args[3].startsWith('--')))
      || !rangePattern.test(args[1]) || args[1].startsWith('-')) fail(usage);
  const hosts = loadHosts(args[3] || 'scripts/provenance/hosts.json');
  // Git itself supplies the final trailer block, including duplicates, rather
  // than matching arbitrary body lines. argv + -- disallows option/path injection.
  const result = spawnSync('git', ['--no-pager', 'log', '--no-show-signature', '--no-notes',
    '--format=%H%x00%(trailers:only,unfold)', '-z', args[1], '--'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0) fail('invalid/nonexistent range or git log failed');
  if (!result.stdout) fail('empty revision range');
  const records = result.stdout.split('\0');
  if (records.pop() !== '' || records.length % 2) fail('malformed git log output');
  for (let i = 0; i < records.length; i += 2) {
    const sha = records[i];
    if (!/^[a-f0-9]{40,64}$/.test(sha)) fail('malformed commit identity');
    try { validate(records[i + 1], hosts); console.log(`${sha} PASS declared provenance`); }
    catch (error) { console.log(`${sha} FAIL ${error.message}`); process.exitCode = 1; }
  }
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
