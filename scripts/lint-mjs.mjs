// Dependency-free syntax lint: runs `node --check` on scripts/*.mjs and tests/**/*.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(p)) : [p];
}) : [];
const files = [...walk(path.join(root, 'scripts')), ...walk(path.join(root, 'tests'))].filter(f => f.endsWith('.mjs'));
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(path.relative(root, f) + '\n' + r.stderr); }
}
if (bad) { console.error(`lint-mjs: ${bad} file(s) failed`); process.exit(1); }
console.log(`lint-mjs: OK (${files.length} files)`);
