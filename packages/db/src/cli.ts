import { resolve } from 'node:path';
import { migrate, openDatabase } from './index.ts';

const cmd = process.argv[2];
if (cmd !== 'migrate') {
  console.error('usage: cli.ts migrate');
  process.exit(2);
}
try {
  process.loadEnvFile(resolve(process.cwd(), '.env'));
} catch {
  /* .env is optional */
}
const path = process.env.DATABASE_PATH ?? './data/travel.sqlite';
const db = openDatabase(path);
const applied = migrate(db);
db.close();
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
