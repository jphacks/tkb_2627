import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDatabase } from './index.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const cmd = process.argv[2];
if (cmd !== 'migrate') {
  console.error('usage: cli.ts migrate');
  process.exit(2);
}
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  /* .env is optional */
}
// Relative paths resolve from the repo root, same as apps/server, so both use one DB file.
const path = resolve(REPO_ROOT, process.env.DATABASE_PATH ?? './data/travel.sqlite');
const db = openDatabase(path);
const applied = migrate(db);
db.close();
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
