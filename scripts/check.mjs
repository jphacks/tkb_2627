// Secret-candidate scanner (Node stdlib only). Usage: node scripts/check.mjs [--staged] [--root <dir>]
// Scans git-tracked files (plus staged files with --staged). Exit 1 on findings.
// Output: file, line, rule only. Matched secret values are never printed (4-char prefix + mask at most).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const ri = args.indexOf('--root');
if (ri >= 0 && !args[ri + 1]) { console.error('--root requires a directory'); process.exit(2); }
const root = path.resolve(ri >= 0 ? args[ri + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const staged = args.includes('--staged');
const MAX_BYTES = 2 * 1024 * 1024;

// Allowlist: basename -> reason. Keep minimal.
// Exact lowercase match only; the env-line rule still applies to them (values must be empty).
// If a data/ or backups/ exception is ever needed, change both .gitignore and this scanner.
const ALLOW_ENV_TEMPLATES = new Set(['.env.example', '.env.ai-local.example']);
const ENV_NAME = /^(?:\.env(?:\..+)?|.+\.env|\.envrc)$/i;

const git = a => execFileSync('git', a, { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\0').filter(Boolean);
let files;
const stagedSet = new Set();
try {
  files = new Set(git(['ls-files', '-z']));
  if (staged) for (const f of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])) { files.add(f); stagedSet.add(f); }
} catch (e) { console.error('check:secrets: git failed in ' + root); process.exit(2); }

const baseName = f => f.split('/').pop();
const pathRules = [
  ['env-file', f => ENV_NAME.test(baseName(f)) && !ALLOW_ENV_TEMPLATES.has(baseName(f))],
  ['database-file', f => /\.(sqlite3?|db)(-wal|-shm)?$/i.test(f)],
  ['data-or-backups-dir', f => /(^|\/)(data|backups)\//i.test(f)],
  ['archive-file', f => /\.zip$/i.test(f)],
  ['credentials-file', f => /(^|\/)(\.credentials\.json|credentials\.json|client_secret[^/]*\.json|token\.json|service-account[^/]*\.json|\.netrc|id_rsa|id_ed25519)$/i.test(f) || /\.(pem|p12|pfx)$/i.test(f)],
];
const contentRules = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{40,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private-key-block', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
];
const envLine = /^\s*(?:export\s+)?[A-Za-z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD)[A-Za-z0-9_]*\s*=\s*(.*)$/i;
const mask = s => s.slice(0, 4) + '****';

const findings = [];
let skipped = 0;
for (const f of [...files].sort()) {
  for (const [name, test] of pathRules) if (test(f)) findings.push(`${f}: [${name}] (path)`);
  const abs = path.join(root, f);
  let buf;
  try {
    if (stagedSet.has(f)) buf = execFileSync('git', ['show', ':' + f], { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    else { const st = fs.statSync(abs); if (!st.isFile()) continue; if (st.size > MAX_BYTES) { skipped++; continue; } buf = fs.readFileSync(abs); }
  } catch { continue; }
  if (buf.length > MAX_BYTES || buf.subarray(0, 8000).includes(0)) { skipped++; continue; }
  const isEnv = ENV_NAME.test(baseName(f));
  buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of contentRules) {
      const m = re.exec(line);
      if (m) findings.push(`${f}:${i + 1}: [${name}] ${mask(m[0])}`);
    }
    if (isEnv) {
      const m = envLine.exec(line);
      if (m) {
        const v = m[1].replace(/(^|\s)#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
        if (v) findings.push(`${f}:${i + 1}: [env-secret-value] (value hidden)`);
      }
    }
  });
}
if (findings.length) {
  console.error('check:secrets: ' + findings.length + ' candidate(s) found');
  for (const x of findings) console.error('  ' + x);
  process.exit(1);
}
console.log(`check:secrets: OK (${files.size} files, ${skipped} skipped as large/binary)`);
