import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Self-describing format: scrypt$N$r$p$saltB64$hashB64 so parameters can be raised later.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((res, rej) =>
    scrypt(password.normalize('NFKC'), salt, len, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? rej(e) : res(k))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every(Number.isInteger) || n < 2 || n > 1 << 17 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (salt.length < 8 || expected.length < 16) return false;
  try {
    const actual = await derive(password, salt, n, r, p, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false; // e.g. stored parameters exceed memory limits
  }
}

let dummy: Promise<string> | undefined;
/** Precompute at startup so the first unknown-loginId attempt costs the same as the rest. */
export function prepareDummy(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
/** Spends the same work as a real check so unknown loginIds are not distinguishable by timing. */
export async function verifyDummy(password: string): Promise<false> {
  await verifyPassword(password, await prepareDummy());
  return false;
}
