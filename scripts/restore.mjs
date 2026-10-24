// usage: npm run db:restore -- <backupFile> --to <new db path>
// Restores into a NEW file only. Never touches DATABASE_PATH. See docs/backup.md for the swap procedure.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { register } from 'tsx/esm/api';

const root = fileURLToPath(new URL('../', import.meta.url));
const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const usage = 'usage: npm run db:restore -- <backupFile> --to <new db path>';
let values, positionals;
try {
  ({ values, positionals } = parseArgs({ options: { to: { type: 'string' } }, allowPositionals: true, strict: true }));
} catch {
  die(usage);
}
if (positionals.length !== 1 || !values.to) die(usage);
try {
  process.loadEnvFile(resolve(root, '.env'));
} catch {
  /* .env is optional */
}
register();
const { restoreDatabase, formatSummary } = await import('../packages/db/src/backup.ts');
const live = resolve(root, process.env.DATABASE_PATH ?? './data/travel.sqlite');
const from = resolve(root, positionals[0]);
const to = resolve(root, values.to);
if (to === live) die('--to must not be the live DATABASE_PATH; restore elsewhere, then swap manually (docs/backup.md)');
try {
  const r = restoreDatabase(from, to);
  console.log(`restored to: ${to}`);
  console.log(r.applied.length ? `applied migrations: ${r.applied.join(', ')}` : 'migrations: up to date');
  console.log(formatSummary(r));
} catch (e) {
  die(e.message);
}
