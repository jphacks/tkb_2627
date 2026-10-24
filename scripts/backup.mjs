// usage: npm run db:backup [-- --out <file>]
// Snapshots DATABASE_PATH (WAL-safe, VACUUM INTO) to backups/travel-<UTC>.sqlite. Never overwrites.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { register } from 'tsx/esm/api';

const root = fileURLToPath(new URL('../', import.meta.url));
const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
let values;
try {
  ({ values } = parseArgs({ options: { out: { type: 'string' } }, strict: true }));
} catch {
  die('usage: npm run db:backup [-- --out <file>]');
}
try {
  process.loadEnvFile(resolve(root, '.env'));
} catch {
  /* .env is optional */
}
register();
const { backupDatabase, formatSummary } = await import('../packages/db/src/backup.ts');
const src = resolve(root, process.env.DATABASE_PATH ?? './data/travel.sqlite');
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '');
const out = resolve(root, values.out ?? `backups/travel-${stamp}.sqlite`);
try {
  const summary = backupDatabase(src, out);
  for (const w of summary.warnings) console.error(`warning: ${w}`);
  console.log(`backup written: ${out}`);
  console.log(formatSummary(summary));
} catch (e) {
  die(e.message);
}
