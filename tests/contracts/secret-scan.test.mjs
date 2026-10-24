import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/check.mjs');
const x = n => 'x'.repeat(n);

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkb-scan-'));
  dirs.push(dir);
  const sh = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  sh('init', '-q');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  sh('add', '-A', '-f');
  return dir;
}
const run = dir => { const r = spawnSync(process.execPath, [CHECK, '--root', dir], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

test('clean repo and empty .env.example pass', () => {
  const dir = repo({ 'README.md': 'hello', '.env.example': 'API_KEY=\nSECRET_TOKEN=\n# comment\n' });
  assert.equal(run(dir).code, 0);
});

test('key patterns are detected without printing the full value', () => {
  const secrets = {
    anthropic: 'sk-ant-' + x(40),
    openai: 'sk-' + x(40),
    github: 'ghp_' + x(40),
    google: 'AIza' + x(35),
    aws: 'AKIA' + 'X'.repeat(16),
  };
  for (const [name, v] of Object.entries(secrets)) {
    const dir = repo({ 'src/a.txt': `line1\nvalue = ${v}\n` });
    const r = run(dir);
    assert.equal(r.code, 1, name);
    assert.ok(r.out.includes('src/a.txt:2'), name);
    assert.ok(!r.out.includes(v), name + ' leaked');
  }
});

test('private key block is detected', () => {
  const dir = repo({ 'k.txt': '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' });
  assert.equal(run(dir).code, 1);
});

test('.env, sqlite, data/ and credentials files are rejected', () => {
  for (const name of ['.env', 'apps/x/.env.local', 'a.sqlite', 'a.db-wal', 'data/x.json', 'backups/y.txt', '.credentials.json']) {
    assert.equal(run(repo({ [name]: 'z' })).code, 1, name);
  }
});

test('non-empty secret value in .env.example is rejected and hidden', () => {
  const v = 'abc' + x(10);
  const r = run(repo({ '.env.example': `SESSION_SECRET=${v}\n` }));
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes(v));
});

test('env names are case-insensitive; *.env and .envrc rejected; lowercase templates allowed', () => {
  for (const name of ['.ENV', '.Env.Local', 'prod.env', '.envrc', 'Data/x.json', 'BACKUPS/y']) {
    assert.equal(run(repo({ [name]: 'z' })).code, 1, name);
  }
  assert.equal(run(repo({ '.env.ai-local.example': 'A_KEY=\n' })).code, 0);
  assert.equal(run(repo({ '.ENV.EXAMPLE': 'z' })).code, 1);
});

test('kebab identifiers are not flagged as sk- keys; long sk- keys are', () => {
  assert.equal(run(repo({ 'a.md': 'sk-' + 'some-long-kebab-case-identifier-name-that-goes-on-and-on' })).code, 0);
  assert.equal(run(repo({ 'a.md': 'sk-proj-' + x(50) })).code, 1);
});

test('trailing comment after empty env value is treated as empty', () => {
  assert.equal(run(repo({ '.env.example': 'API_KEY= # set me\nOTHER_TOKEN=#x\n' })).code, 0);
  assert.equal(run(repo({ '.env.example': 'API_KEY=v' + x(5) + ' # c\n' })).code, 1);
});

test('--staged reads index content, not the working tree', () => {
  const dir = repo({ 'a.txt': 'ok' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'AIza' + x(35));
  spawnSync('git', ['add', 'a.txt'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'clean again');
  const r = spawnSync(process.execPath, [CHECK, '--root', dir, '--staged'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});

test('zip is rejected; skipped binaries are counted', () => {
  assert.equal(run(repo({ 'kit.zip': 'z' })).code, 1);
  const dir = repo({ 'a.bin': Buffer.from([0, 1, 2, 3]).toString('latin1') });
  assert.match(run(dir).out, /1 skipped/);
});
