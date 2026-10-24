// Pure helpers for scripts/review.mjs (unit-tested in tests/review.test.mjs).
import { createServer } from 'node:net';

/** First non-internal IPv4 address from os.networkInterfaces(), or null. Prefers private ranges. */
export function pickLanIp(interfaces) {
  const all = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const i of list ?? []) {
      const fam = typeof i.family === 'string' ? i.family : i.family === 4 ? 'IPv4' : 'IPv6';
      if (fam === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) all.push(i.address);
    }
  }
  const isPrivate = a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return all.find(isPrivate) ?? all[0] ?? null;
}

/** First port in [start, end] for which isFree(port) resolves true; null when none. */
export async function pickPort(start, end, isFree, skip = []) {
  for (let p = start; p <= end; p++) {
    if (skip.includes(p)) continue;
    if (await isFree(p)) return p;
  }
  return null;
}

/** Can we listen on this port on the given host. */
export function canListen(port, host) {
  return new Promise(res => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, host, () => s.close(() => res(true)));
  });
}

/** Free on every host? (A listener on 127.0.0.1 does not block 0.0.0.0 on macOS, so check both.) */
export async function canListenAll(port, hosts = ['127.0.0.1', '0.0.0.0']) {
  for (const h of hosts) if (!(await canListen(port, h))) return false;
  return true;
}

/** Decide what to do per demo user. Never overwrites: a user without a saved password cannot be used. */
export function planUsers(logins, existingLogins, pwFileLogins) {
  return logins.map(login => {
    const exists = existingLogins.has(login);
    const hasPw = pwFileLogins.has(login);
    if (!exists) return { login, action: 'create' };
    return { login, action: hasPw ? 'reuse' : 'broken' };
  });
}

/** Seed only when demo-a has no trip yet (idempotent re-runs). */
export const needsSeed = tripList => !(tripList?.items?.length > 0);

/** Child env for review mode: fixture only, no Claude execution, no public origin. */
export function reviewEnv(base, { dbPath, apiPort, webPort, sessionSecret }) {
  return {
    ...base,
    DATABASE_PATH: dbPath,
    SHARED_BIND: '127.0.0.1',
    SHARED_PORT: String(apiPort),
    PROVIDER_MODE: 'fixture',
    ALLOW_CLAUDE_EXECUTION: 'false',
    PUBLIC_ORIGIN: '',
    TRUST_PROXY: '',
    SESSION_SECRET: sessionSecret,
    TKB_REVIEW_LAN: '1',
    TKB_API_PORT: String(apiPort),
    TKB_WEB_PORT: String(webPort),
  };
}

/** The block printed when everything is ready. */
export function formatReady({ webPort, lanIp, creds }) {
  const lines = ['', '✅ 確認用の画面が起動しました（止めるときは Ctrl+C）', `PCで開く:   http://127.0.0.1:${webPort}/`];
  lines.push(
    lanIp
      ? `スマホで開く（同じWi‑Fi）: http://${lanIp}:${webPort}/`
      : 'スマホからは開けません（Wi‑Fiに未接続）',
  );
  lines.push(`ログイン: ${creds.map(c => `${c.login} / ${c.password}`).join('    ')}`);
  lines.push('確認する画面とコメント先: ホーム画面の一番下「UI確認用：全画面の一覧」');
  if (lanIp) lines.push('（会社・学校のWi‑Fiは端末どうしの通信を止めていることがあります。開けないときはPCで確認してください）');
  return lines.join('\n');
}
