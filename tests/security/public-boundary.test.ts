// T05-1/2/6: the public (shared) entry cannot reach the personal AI entry; no SSRF path; Host/XFF spoofing.
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp as buildLocal } from '../../apps/ai-local/src/app.ts';
import { loadConfig as loadLocal } from '../../apps/ai-local/src/config.ts';
import { createCapabilitiesClient, createContextClient, createPlanBatchClient, createSharedClient, UPSTREAM_CAPABILITIES_PATHS, UPSTREAM_CONTEXT_PATHS, UPSTREAM_PATHS } from '../../apps/ai-local/src/shared-client/index.ts';
import { ApiError } from '@tkb/contracts';
import { PW, fixtureDist, makeShared, ROOT, read, rel, sourceFiles, type Shared } from './helpers.ts';

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
const shared = async (env: Record<string, string> = {}, staticDir: string | null = fixtureDist()) => {
  const s = await makeShared(env, { staticDir });
  apps.push(s.app);
  return s;
};

const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const LOCAL_PATHS = [
  '/local/v1/generations', '/local/v1/pair', '/local/v1/auth/login', '/local/v1/jobs/job_x', '/local/v1/jobs/job_x/cancel',
  '/local/v1/capabilities', '/local/v1/session', '/local/v1/health', '/local/',
  '/LOCAL/v1/generations', '/Local/V1/Pair', '/local/v1/generations/', '/local//v1//generations',
  '/%6Cocal/v1/generations', '/%6cocal/v1/pair', '/local%2Fv1%2Fgenerations', '/local%2fv1/pair',
  '/api/v1/../local/v1/generations', '/api/v1/%2e%2e/local/v1/pair', '/api/v1/%2E%2E/%2E%2E/local/v1/pair',
  '/api/v1/generations', '/api/v1/generations/', '/API/V1/GENERATIONS', '/api/v1/jobs/x', '/api/v1/pair', '/api/v1/ai/generate',
  '/local/v1/pair?x=/api/v1/health', '/local/v1/pair#x',
];

describe('T05-1 shared entry never reaches the personal AI entry', () => {
  it('route table of the shared app has zero generation / job / pairing / local routes (with static delivery on)', async () => {
    const { app } = await shared();
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false, includeHooks: false });
    expect(routes).toContain('health');
    expect(routes).not.toMatch(/local|generat|pair|jobs?\b|cancel|claude|runner|admin|debug/i);
  });

  it('no route is reachable at any spelling and method; nothing is served as 2xx, an SPA page, or a redirect', async () => {
    const { app } = await shared();
    for (const url of LOCAL_PATHS) {
      for (const method of ALL_METHODS) {
        const r = await app.inject({ method, url, payload: ['POST', 'PUT', 'PATCH'].includes(method) ? { code: 'x', constraints: {} } : undefined, headers: { origin: 'http://127.0.0.1:4311' } });
        const where = `${method} ${url}`;
        // Reaching a local/generation handler would be 2xx/202; the SPA shell would be 200 text/html.
        expect(r.statusCode, where).toBeGreaterThanOrEqual(400);
        expect(r.headers.location, where).toBeUndefined();
        expect(String(r.headers['content-type'] ?? ''), where).not.toMatch(/text\/html/);
        expect(r.payload, where).not.toMatch(/jobId|pollAfterMs|csrfToken|Pairing required|tkb_local_sid/);
        expect(r.headers['set-cookie'], where).toBeUndefined();
      }
    }
  });

  it('raw request targets on a real socket (backslashes, //, absolute-form, encoded slashes) never reach /local or serve the SPA for /local', async () => {
    // light-my-request rewrites some of these through WHATWG URL, so send them as raw bytes over loopback.
    const { app } = await shared();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const targets = ['/\\local\\v1\\pair', '/\\local/v1/pair', '//local/v1/pair', '///local/v1/generations', 'http://evil.example/local/v1/pair', 'http://127.0.0.1:4311/local/v1/generations', '/%5clocal%5cv1%5cpair', '/local/v1/pair', '/api/v1/..%2flocal/v1/pair', '/api/v1/%2e%2e/local/v1/pair'];
    for (const target of targets) {
      const raw = await new Promise<string>((resolve, reject) => {
        const sock = connect(port, '127.0.0.1', () => sock.write(`POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`));
        let buf = '';
        sock.on('data', d => (buf += d)).on('end', () => resolve(buf)).on('error', reject);
      });
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
      expect(status, JSON.stringify(target)).toBeGreaterThanOrEqual(400);
      expect(raw, JSON.stringify(target)).not.toMatch(/jobId|pollAfterMs|csrfToken|set-cookie/i);
    }
    // GET of the same targets must not be answered with the SPA shell for reserved prefixes.
    for (const target of ['/\\local\\v1\\pair', '//local/v1/pair', '/\\api\\v1\\health']) {
      const raw = await new Promise<string>((resolve, reject) => {
        const sock = connect(port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
        let buf = '';
        sock.on('data', d => (buf += d)).on('end', () => resolve(buf)).on('error', reject);
      });
      expect(raw, JSON.stringify(target)).not.toContain('<title>spa</title>');
      expect(Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0), JSON.stringify(target)).toBeGreaterThanOrEqual(400);
    }
  });

  it('a Host header naming the personal origin does not change anything on the shared app', async () => {
    const { app } = await shared();
    for (const host of ['127.0.0.1:4311', 'localhost:4311', 'evil.example']) {
      const r = await app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: 'x' }, headers: { host, origin: `http://${host}` } });
      expect(r.statusCode, host).toBeGreaterThanOrEqual(400);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });

  it('shared and personal apps built in the same process stay disjoint: the shared app owns no /local route, the personal app owns no /api route', async () => {
    const s = await shared();
    const local = buildLocal({ config: loadLocal({ PERSONAL_OWNER_USER_ID: 'user_a' }), fetch: async () => new Response('{}', { status: 500 }) });
    apps.push(local);
    await s.app.ready();
    await local.ready();
    const sharedRoutes = s.app.printRoutes({ commonPrefix: false });
    const localRoutes = local.printRoutes({ commonPrefix: false });
    expect(sharedRoutes).not.toContain('local/');
    expect(localRoutes).not.toMatch(/\/api\//);
    // The personal entry has no static/SPA fallback: unknown paths are plain K23 404, even for the shared app's paths.
    const r = await local.inject({ url: '/api/v1/health', headers: { host: '127.0.0.1:4311' } });
    expect(r.statusCode).toBe(404);
    // A shared-server session cookie does not authenticate against the personal entry (one direction; the reverse is covered by the no-/local-route checks above).
    const sr = await s.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW } });
    expect(sr.statusCode).toBe(200);
    const sharedCookie = String(sr.headers['set-cookie']).split(';')[0]!;
    const lr = await local.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'user-a', password: PW }, headers: { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311', cookie: sharedCookie } });
    expect(lr.statusCode).toBe(401); // a shared-server session cookie is not a personal-entry pairing
  });
});

describe('T05-2 SSRF: no path lets a client choose an outbound URL', () => {
  it('server and ai-local sources never call fetch/http(s).request/net.connect except the single shared-client call', () => {
    const files = sourceFiles(['apps/server/src', 'apps/ai-local/src', 'packages/ai/src', 'packages/db/src', 'packages/contracts/src', 'packages/planner/src', 'packages/exports/src', 'packages/travel-data/src', 'packages/fixtures/src', 'scripts'], { skipTests: true });
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const f of files) {
      const t = read(f);
      for (const m of t.matchAll(/\b(fetch\s*\(|https?\.(request|get)\s*\(|net\.(connect|createConnection)\s*\(|undici|node-fetch|axios|XMLHttpRequest|WebSocket\s*\(|dns\.(lookup|resolve))/g)) hits.push(`${rel(f)}: ${m[0]}`);
      expect(t, rel(f)).not.toMatch(/(from\s+|import\s*\(\s*|require\s*\(\s*)['"](node:)?(http|https|http2|net|tls|dgram|dns|undici|node-fetch|axios|ws)['"]/);
      expect(t, rel(f)).not.toMatch(/\brequire\s*\(/);
    }
    expect(hits).toEqual(['apps/ai-local/src/shared-client/index.ts: fetch(']);
  });

  it('the only outbound call target is baseUrl + a constant path; client-controlled values never reach the URL', () => {
    const t = read(sourceFiles(['apps/ai-local/src/shared-client']).find(f => f.endsWith('shared-client/index.ts'))!);
    expect(t).toContain('`${base}${UPSTREAM_PATHS.login}`');
    expect(Object.values(UPSTREAM_PATHS)).toEqual(['/api/v1/auth/login']);
    expect(t).toContain("redirect: 'manual'");
  });

  it('login through the personal entry calls exactly SHARED_BASE_URL + fixed path, whatever the client sends (URL-like loginId, absolute-URL/`//evil` fields, Host/Referer/X-Forwarded-*)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const H = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
    const { PairingStore } = await import('../../apps/ai-local/src/auth/pairing.ts');
    const pairing = new PairingStore({ ttlMs: 60_000 });
    const l2 = buildLocal({
      config: loadLocal({ PERSONAL_OWNER_USER_ID: 'user_a', SHARED_BASE_URL: 'http://127.0.0.1:4310///' }),
      pairing,
      fetch: async (url, init) => (calls.push({ url, init }), new Response('{}', { status: 401 })),
    });
    apps.push(l2);
    const p = await l2.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: pairing.issue() }, headers: H });
    const cookie = String(p.headers['set-cookie']).split(';')[0]!;
    const csrf = (p.json() as { csrfToken: string }).csrfToken;
    const evil = ['http://evil.example/steal', '//evil.example', 'https://169.254.169.254/latest/meta-data', 'file:///etc/passwd', '@evil.example', '../../x'];
    let reachedUpstream = 0;
    for (const v of evil) {
      for (const body of [{ loginId: v, password: v }, { loginId: 'a', password: 'b', url: v, baseUrl: v, path: v, host: v }]) {
        const r = await l2.inject({ method: 'POST', url: '/local/v1/auth/login', payload: body, headers: { ...H, cookie, 'x-csrf-token': csrf, referer: v, 'x-forwarded-host': v, 'x-forwarded-for': '169.254.169.254' } });
        expect(r.statusCode).toBeGreaterThanOrEqual(400);
        if (r.statusCode === 401) reachedUpstream++; // upstream mock answers 401; 422 means rejected before any call
      }
    }
    expect(reachedUpstream).toBeGreaterThanOrEqual(evil.length); // every URL-like loginId/password pair was a valid body
    // Query strings and path suffixes on the local route cannot redirect the upstream call either.
    const q = await l2.inject({ method: 'POST', url: '/local/v1/auth/login?url=http://evil.example&next=//evil.example', payload: { loginId: 'a', password: 'b' }, headers: { ...H, cookie, 'x-csrf-token': csrf } });
    expect(q.statusCode).toBe(401);
    expect(calls).toHaveLength(reachedUpstream + 1); // one upstream call per accepted request, none for rejected ones
    for (const c of calls) {
      expect(c.url).toBe('http://127.0.0.1:4310/api/v1/auth/login');
      const h = new Headers(c.init.headers as Record<string, string>);
      expect([...h.keys()]).toEqual(['content-type']);
      expect(c.init.redirect).toBe('manual');
      // Only the two LoginRequest fields are forwarded; url/baseUrl/path/host never are.
      expect(Object.keys(JSON.parse(String(c.init.body))).sort()).toEqual(['loginId', 'password']);
    }
  });

  it('shared client does not follow upstream redirects to another host and never forwards credentials there', async () => {
    const seen: string[] = [];
    const redirects: unknown[] = [];
    const client = createSharedClient({
      baseUrl: 'http://127.0.0.1:4310',
      // Record only: an expect() inside the mock would be swallowed by the client's try/catch around fetch.
      fetch: async (url, init) => {
        seen.push(url);
        redirects.push(init.redirect);
        return new Response(null, { status: 302, headers: { location: 'http://evil.example/' } });
      },
    });
    const r = await client.login({ loginId: 'a', password: 'b' });
    expect(redirects).toEqual(['manual']); // the real fetch would not follow; the 3xx surfaces as an error
    expect(seen).toEqual(['http://127.0.0.1:4310/api/v1/auth/login']); // exactly one call, no second hop to the Location host
    expect(r).toEqual({ ok: false, code: 'UNAVAILABLE', retryable: true });
  });

  it('PlanBatchClient exposes exactly save/find and no /local route forwards arbitrary input to it', () => {
    expect(Object.keys(createPlanBatchClient({ baseUrl: 'http://127.0.0.1:4310' }))).toEqual(['savePlanBatch', 'findPlanBatchByGenerationId']);
    const app = read(join(ROOT, 'apps/ai-local/src/app.ts'));
    // The only uses: restart-recovery lookup with a server-derived operationKey (nothing from the request).
    expect([...app.matchAll(/planClient\.\w+\(([^)]*)\)/g)].map(m => m[0])).toEqual(['planClient.findPlanBatchByGenerationId(s, operationKey)']);
  });

  it('ContextClient (K05) exposes exactly getPlanningContext, calls one constant path with manual redirects, and no /local route reaches it', () => {
    expect(Object.keys(createContextClient({ baseUrl: 'http://127.0.0.1:4310' }))).toEqual(['getPlanningContext']);
    expect(Object.values(UPSTREAM_CONTEXT_PATHS)).toEqual(['/api/v1/planning-context']);
    const t = read(sourceFiles(['apps/ai-local/src/shared-client']).find(f => f.endsWith('shared-client/index.ts'))!);
    expect(t).toContain('`${base}${UPSTREAM_CONTEXT_PATHS.planningContext}`');
    expect(read(join(ROOT, 'apps/ai-local/src/app.ts'))).not.toMatch(/contextClient\.\w+\(/);
  });

  it('CapabilitiesClient exposes exactly getDataMode, calls one constant public path with manual redirects and no credentials', () => {
    expect(Object.keys(createCapabilitiesClient({ baseUrl: 'http://127.0.0.1:4310' }))).toEqual(['getDataMode']);
    expect(Object.values(UPSTREAM_CAPABILITIES_PATHS)).toEqual(['/api/v1/capabilities']);
    const t = read(sourceFiles(['apps/ai-local/src/shared-client']).find(f => f.endsWith('shared-client/index.ts'))!);
    expect(t).toContain('`${base}${UPSTREAM_CAPABILITIES_PATHS.capabilities}`');
    expect([...read(join(ROOT, 'apps/ai-local/src/app.ts')).matchAll(/capabilitiesClient\.\w+\(/g)].map(m => m[0])).toEqual(['capabilitiesClient.getDataMode(']);
  });

  it('shared client exposes no method other than login (no generic proxy)', () => {
    expect(Object.keys(createSharedClient({ baseUrl: 'http://127.0.0.1:4310' }))).toEqual(['login']);
  });

  it('shared server has no route that accepts a URL: no handler schema or body field named url/uri/href/callback/webhook/proxy', () => {
    for (const f of sourceFiles(['apps/server/src'], { skipTests: true })) {
      const t = read(f);
      expect(t, rel(f)).not.toMatch(/\b(callbackUrl|webhook|proxyUrl|imageUrl|fetchUrl|targetUrl|redirectTo|returnTo)\b/i);
      expect(t, rel(f)).not.toMatch(/\.redirect\s*\(/);
    }
  });
});

describe('T05-6 Host / X-Forwarded-For spoofing on the shared entry', () => {
  const attempt = (app: Shared, i: number, headers: Record<string, string>, remoteAddress?: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: `nobody-${i}`, password: 'wrong-password-1' }, headers, remoteAddress });

  it('TRUST_PROXY=loopback: rotating the leftmost (client-supplied) X-Forwarded-For entry does not escape the per-IP limit; the rightmost entry is the key', async () => {
    const { app } = await shared({ TRUST_PROXY: 'loopback' });
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const r = await attempt(app, i, { 'x-forwarded-for': `10.9.${i}.${i}, 198.51.100.7` });
      if (r.statusCode === 429) limited++;
      else expect(r.statusCode).toBe(401);
    }
    expect(limited).toBeGreaterThanOrEqual(9); // 50 allowed, then refused although the leftmost value changed every time
    // A different real client (different rightmost entry, appended by the proxy) is unaffected.
    expect((await attempt(app, 999, { 'x-forwarded-for': '10.9.0.0, 198.51.100.8' })).statusCode).toBe(401);
  }, 60_000);

  it('TRUST_PROXY unset: X-Forwarded-For / Forwarded / X-Real-IP are ignored; the socket address is the key', async () => {
    const { app } = await shared({});
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const r = await attempt(app, i, { 'x-forwarded-for': `10.9.${i}.${i}`, 'x-real-ip': `10.8.${i}.1`, forwarded: `for=10.7.${i}.1` }, '203.0.113.5');
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThanOrEqual(9);
  }, 60_000);

  it('TRUST_PROXY=loopback does not trust a non-loopback peer: a direct client cannot choose its key with X-Forwarded-For', async () => {
    const { app } = await shared({ TRUST_PROXY: 'loopback' });
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const r = await attempt(app, i, { 'x-forwarded-for': `10.9.${i}.${i}` }, '203.0.113.5');
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThanOrEqual(9);
  }, 60_000);

  it('config rejects trusting every proxy hop (TRUST_PROXY=true / 1 / CIDR lists)', async () => {
    const { loadConfig } = await import('../../apps/server/src/platform/config.ts');
    for (const v of ['true', '1', '*', '0.0.0.0/0', 'loopback,10.0.0.0/8', 'yes']) {
      expect(() => loadConfig({ SESSION_SECRET: 's'.repeat(40), TRUST_PROXY: v }), v).toThrow(/TRUST_PROXY/);
    }
  });

  it('a spoofed Host or X-Forwarded-Host cannot make a cross-origin write pass on an https public origin', async () => {
    const { app } = await shared({ PUBLIC_ORIGIN: 'https://demo.example.trycloudflare.com', TRUST_PROXY: 'loopback' });
    for (const headers of [
      { origin: 'https://evil.example', host: 'demo.example.trycloudflare.com' },
      { origin: 'http://demo.example.trycloudflare.com' },
      { origin: 'https://demo.example.trycloudflare.com.evil.example', 'x-forwarded-host': 'demo.example.trycloudflare.com' },
      { origin: 'null' },
      { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' }, // dev origins are off once PUBLIC_ORIGIN is set
    ]) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW }, headers });
      expect(r.statusCode, JSON.stringify(headers)).toBe(403);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW }, headers: { origin: 'https://demo.example.trycloudflare.com' } });
    expect(ok.statusCode).toBe(200);
  });

  it('error bodies come back in the K23 shape for the spoofed requests above', async () => {
    const { app } = await shared();
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'a', password: 'b' }, headers: { origin: 'https://evil.example' } });
    expect(ApiError.parse(r.json()).code).toBe('FORBIDDEN');
  });
});
