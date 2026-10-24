// Runs tsx via node (equivalent to `npx tsx`, no .cmd shim so shell:false works on Windows).
// Creates data/ and applies DB migrations. Does not create .env.
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const r = spawnSync(process.execPath, ['--import', 'tsx', 'packages/db/src/cli.ts', 'migrate'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
process.exit(r.status ?? 1);
