// Invite-only user creation. There is no public sign-up API.
// usage: TKB_NEW_PASSWORD=... npm run user:create -- --login demo-a --name "Demo A"
//        (or pipe the password on stdin). The password is never taken from argv.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { register } from 'tsx/esm/api';

const root = fileURLToPath(new URL('../', import.meta.url));
const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

let values;
try {
  ({ values } = parseArgs({ options: { login: { type: 'string' }, name: { type: 'string' } }, strict: true }));
} catch {
  die('usage: npm run user:create -- --login <id> --name <display name>  (password via TKB_NEW_PASSWORD or stdin)');
}
const loginId = values.login?.trim().toLowerCase();
const displayName = values.name?.trim();
if (!loginId || !displayName) die('--login and --name are required');
if (!/^[A-Za-z0-9_.-]{1,64}$/.test(loginId)) die('login must match [A-Za-z0-9_.-]{1,64}');

let password = process.env.TKB_NEW_PASSWORD;
if (!password) {
  if (process.stdin.isTTY) {
    // Interactive: prompt on stderr, no echo of the typed characters.
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stderr.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    password = await new Promise((res) => {
      rl.question('Password (input hidden): ', (a) => res(a));
      muted = true;
    });
    rl.close();
    process.stderr.write('\n');
  } else password = (await new Promise((res) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (s += c));
    process.stdin.on('end', () => res(s));
  })).replace(/\r?\n$/, '');
}
if (password.length < 12 || password.length > 256) die('password must be 12 to 256 characters');

try {
  process.loadEnvFile(resolve(root, '.env'));
} catch {
  /* .env is optional */
}
register();
const { openDatabase, migrate, createUser } = await import('../packages/db/src/index.ts');
const { hashPassword } = await import('../apps/server/src/platform/auth/password.ts');

const dbPath = process.env.DATABASE_PATH ?? './data/travel.sqlite';
const db = openDatabase(dbPath === ':memory:' ? dbPath : resolve(root, dbPath));
try {
  migrate(db);
  const id = `user_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  createUser(db, {
    id,
    loginId,
    passwordHash: await hashPassword(password),
    displayName,
    createdAt: new Date().toISOString(),
  });
  console.log(`created user ${loginId} (${id})`);
} catch (e) {
  db.close();
  die(/UNIQUE/i.test(String(e?.message)) ? `login "${loginId}" already exists` : 'failed to create user');
}
db.close();
