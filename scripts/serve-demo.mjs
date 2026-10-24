// Pre-flight check for the public demo (docs/deployment.md). Dependency-free.
// Only validates and prints the command a human runs next. It never starts a tunnel or a server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env')); // does not override variables already set
} catch {
  /* .env is optional */
}
const env = process.env;
const problems = [];

// 1. Settings (values are never printed).
const origin = (env.PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '');
try {
  const u = new URL(origin);
  if (u.protocol !== 'https:' || u.origin !== origin) problems.push('PUBLIC_ORIGIN must be an https origin such as https://xxxx.trycloudflare.com');
} catch {
  problems.push('PUBLIC_ORIGIN must be an https origin such as https://xxxx.trycloudflare.com');
}
if ((env.SESSION_SECRET ?? '').length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
if (env.TRUST_PROXY !== 'loopback') problems.push('TRUST_PROXY must be "loopback"');
if ((env.SHARED_BIND ?? '127.0.0.1') !== '127.0.0.1') problems.push('SHARED_BIND must be 127.0.0.1 (the tunnel connects from this machine)');
if ((env.PROVIDER_MODE ?? 'fixture') !== 'fixture') problems.push('PROVIDER_MODE must be "fixture" (live providers are not implemented)');
if (!fs.existsSync(path.join(root, 'apps/web/dist/index.html'))) problems.push('apps/web/dist is missing: run "npm run build" first');

const port = Number(env.SHARED_PORT ?? 4310);
const personalPort = Number(env.PERSONAL_PORT ?? 4311);
if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('SHARED_PORT must be an integer from 1 to 65535');
else if ([4311, personalPort, 5173].includes(port)) problems.push('SHARED_PORT must not be the personal AI port (4311 / PERSONAL_PORT) or the dev port (5173)');

// 2. The shared server must not be able to run the local AI / Claude CLI.
const FORBIDDEN = [
  [/child_process/, 'child_process'],
  [/@tkb\/ai/, '@tkb/ai import'],
  [/\bspawn\s*\(/, 'spawn('],
  [/\bexecFile(Sync)?\s*\(/, 'execFile('],
  [/ALLOW_CLAUDE_EXECUTION/, 'ALLOW_CLAUDE_EXECUTION'],
];
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(p)) : [p];
});
for (const f of walk(path.join(root, 'apps/server/src')).filter(f => /\.(ts|mjs|js)$/.test(f))) {
  const text = fs.readFileSync(f, 'utf8');
  for (const [re, label] of FORBIDDEN) {
    if (re.test(text)) problems.push(`shared server source must not contain ${label}: ${path.relative(root, f)}`);
  }
}
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'apps/server/package.json'), 'utf8'));
  if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).includes('@tkb/ai')) problems.push('apps/server must not depend on @tkb/ai');
} catch {
  problems.push('apps/server/package.json is unreadable');
}

if (problems.length) {
  console.error('serve-demo: NOT READY');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`serve-demo: checks passed (only the shared server on 127.0.0.1:${port} is to be exposed).`);
console.log('Run these yourself (this script starts nothing):');
console.log('  1) npm run start:shared');
console.log(`  2) cloudflared tunnel --url http://127.0.0.1:${port}`);
console.log('Never tunnel port 4311 (personal AI) or 5173 (dev). See docs/deployment.md.');
