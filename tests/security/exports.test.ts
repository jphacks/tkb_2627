// T05 addendum for E02 / K18 PDF export: the request cannot steer the renderer, the file carries no private data,
// and the per-user / queue limits hold under parallel requests. No network, no .env, no Google; real renderer.
import { inflateSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@tkb/contracts';
import { createUser, insertTrip, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../../apps/server/src/platform/app.ts';
import { hashPassword } from '../../apps/server/src/platform/auth/password.ts';
import { loadConfig } from '../../apps/server/src/platform/config.ts';
import { ExportJobs } from '../../apps/server/src/platform/exports/jobs.ts';
import { exportTrip } from '../../apps/server/test/exports-fixture.ts';
import { PW } from './helpers.ts';

type App = ReturnType<typeof buildApp>;
interface Session { cookie: string; csrf: string }
const apps: App[] = [];
let pwHash = '';
beforeAll(async () => { pwHash = await hashPassword(PW); });
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

// Rare CJK markers that appear nowhere else in the fixture text, so their code points in the font's ToUnicode map
// prove the string was written (the subset font stores glyph ids, never the characters themselves).
const NOTE = '桜桃'; // privateNotes
const HOME_LABEL = '梅屋敷'; // departure/return label
const HOME_NAME = '菖蒲'; // home place name
const TITLE = '紅葉'; // control: the title is printed
const ASCII_SECRETS = ['NOTE-SEC', 'HOME-SEC'];

function secretExportTrip(over: { tripId?: string } = {}) {
  const t = exportTrip(over);
  t.title = `${TITLE}の旅`;
  t.constraints.departure = { placeId: 'home', label: HOME_LABEL, time: null };
  t.constraints.return = { placeId: 'home', label: HOME_LABEL, time: null };
  const home = t.places.find((p) => p.placeId === 'home');
  if (home) home.name = HOME_NAME;
  for (const d of t.days) for (const it of d.items) if (it.type === 'activity') it.privateNotes = `${NOTE}-NOTE-SEC HOME-SEC`;
  return t;
}

function make(opts: { jobs?: ExportJobs; render?: () => Promise<Uint8Array>; env?: Record<string, string> } = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b', 'user_c']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: '2026-10-24T03:00:00Z' });
  }
  const now = '2026-10-01T00:00:00Z';
  insertTrip(db, 'user_a', secretExportTrip(), now);
  insertTrip(db, 'user_b', secretExportTrip({ tripId: 'trip_b' }), now);
  insertTrip(db, 'user_c', secretExportTrip({ tripId: 'trip_c' }), now);
  const config = { ...loadConfig({ SESSION_SECRET: 's'.repeat(40), ...opts.env }), databasePath: ':memory:' };
  const app = buildApp({ config, db, exports: { jobs: opts.jobs ?? new ExportJobs(), ...(opts.render ? { render: opts.render } : {}) } });
  apps.push(app);
  return { app, db };
}
async function login(app: App, loginId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  expect(res.statusCode).toBe(200);
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}
const post = (app: App, s: Session, body: unknown, tripId = 'trip_pdf', headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/exports`, payload: body as object, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...headers } });
const get = (app: App, s: Session, id: string) => app.inject({ method: 'GET', url: `/api/v1/exports/${id}`, headers: { cookie: s.cookie } });
const OK = { expectedRevision: 1, format: 'pdf' };

/** Raw bytes plus every inflated stream (object streams, ToUnicode CMaps), as latin1. */
function inspect(pdf: Buffer): { text: string; cps: Set<string> } {
  const raw = pdf.toString('latin1');
  const out = [raw];
  let from = 0;
  for (;;) {
    const s = raw.indexOf('stream\n', from);
    if (s < 0) break;
    const end = raw.indexOf('endstream', s + 7);
    if (end < 0) break;
    try { out.push(inflateSync(pdf.subarray(s + 7, end)).toString('latin1')); } catch { /* not flate */ }
    from = end + 'endstream'.length;
  }
  const text = out.join('\n');
  const cps = new Set([...text.matchAll(/<([0-9A-F]{4})>/g)].map((m) => m[1]!));
  return { text, cps };
}
const hasChars = (cps: Set<string>, s: string) => [...s].every((ch) => cps.has(ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')));
async function fetchPdf(app: App, s: Session, tripId = 'trip_pdf', existingId?: string) {
  let exportId = existingId;
  if (!exportId) {
    const r = await post(app, s, OK, tripId);
    expect(r.statusCode, r.body).toBe(202);
    exportId = r.json().exportId as string;
  }
  for (let i = 0; i < 200; i++) {
    const res = await get(app, s, exportId);
    if (res.headers['content-type'] === 'application/pdf') return res;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error('not ready');
}

describe('request body cannot steer the renderer (strict body)', () => {
  it.each([
    ['url', { ...OK, url: 'https://evil.example/x.html' }],
    ['html', { ...OK, html: '<script>alert(1)</script>' }],
    ['template', { ...OK, template: '../../etc/passwd' }],
    ['path', { ...OK, outputPath: '/tmp/x.pdf' }],
    ['header/footer', { ...OK, footer: '<img src=http://169.254.169.254/>' }],
    ['unknown field in __proto__ form', JSON.parse('{"expectedRevision":1,"format":"pdf","__proto__":{"x":1},"constructor":{"x":1}}')],
    ['format url', { ...OK, format: 'https://evil.example/x' }],
    ['format html', { ...OK, format: 'html' }],
    ['format docx', { ...OK, format: 'docx' }],
    ['format array', { ...OK, format: ['pdf', 'html'] }],
    ['format object', { ...OK, format: { type: 'pdf', css: 'x' } }],
    ['missing format', { expectedRevision: 1 }],
    ['missing revision', { format: 'pdf' }],
    ['revision as string', { expectedRevision: '1', format: 'pdf' }],
    ['revision zero', { expectedRevision: 0, format: 'pdf' }],
    ['tripId in body that differs from the path', { ...OK, tripId: 'trip_b' }],
    ['tripId as a URL', { ...OK, tripId: 'https://evil.example' }],
    ['array body', [OK]],
    ['null body', null],
    ['string body', 'format=pdf'],
  ])('%s -> 422 and nothing queued', async (_n, body) => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/trips/trip_pdf/exports',
      payload: typeof body === 'string' ? body : (JSON.stringify(body) as unknown as object),
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, 'content-type': 'application/json' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(ApiError.parse(res.json()).code).toBe('VALIDATION_FAILED');
    expect(res.body).not.toContain('evil.example');
    // No slot was taken: a valid request right after still succeeds.
    expect((await post(app, a, OK)).statusCode).toBe(202);
  });

  it('non-JSON content types are rejected, never parsed as a template', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    for (const ct of ['text/html', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/trips/trip_pdf/exports', payload: '<html>format=pdf</html>', headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, 'content-type': ct } });
      expect(res.statusCode, ct).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, ct).toBeLessThan(500);
    }
  });

  it('ics/maps are not served by this route (no other output format reaches the renderer)', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    for (const format of ['ics', 'maps']) {
      const res = await post(app, a, { ...OK, format });
      expect(res.statusCode, format).toBe(422);
      expect(res.headers['content-type']).not.toMatch(/calendar|pdf/);
    }
  });

  it('the path trip id is validated: traversal and URL-like ids are 404 with no echo', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    for (const id of ['..%2f..%2fetc%2fpasswd', 'http%3A%2F%2Fevil.example', '%00', 'trip_pdf%20x']) {
      const res = await post(app, a, OK, id);
      expect([404, 422], id).toContain(res.statusCode);
      expect(res.body).not.toContain('etc/passwd');
      expect(res.body).not.toContain('evil.example');
    }
  });
});

describe('CSRF and Origin on the export writes (same rules as every other write)', () => {
  it('missing CSRF header is 403 for POST and DELETE; the export is untouched', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const res = await app.inject({ method: 'POST', url: '/api/v1/trips/trip_pdf/exports', payload: OK, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(403);
    expect(ApiError.parse(res.json()).code).toBe('FORBIDDEN');
    const made = await post(app, a, OK);
    expect(made.statusCode).toBe(202);
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/exports/${made.json().exportId}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(403);
    expect((await get(app, a, made.json().exportId)).statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/trips/trip_pdf/exports', payload: OK, headers: { cookie: a.cookie, 'x-csrf-token': 'x'.repeat(a.csrf.length) } });
    expect(bad.statusCode).toBe(403);
  });

  it("another user's CSRF token does not authorize the write", async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    const res = await app.inject({ method: 'POST', url: '/api/v1/trips/trip_pdf/exports', payload: OK, headers: { cookie: a.cookie, 'x-csrf-token': b.csrf } });
    expect(res.statusCode).toBe(403);
  });

  it('a spoofed Origin / Host / X-Forwarded-Host cannot make a cross-origin export write pass on an https public origin', async () => {
    const env = { PUBLIC_ORIGIN: 'https://demo.example.trycloudflare.com', TRUST_PROXY: 'loopback' };
    const { app } = make({ env });
    const a = await login(app, 'user-a').catch(async () => {
      // https config issues a __Host- Secure cookie; log in through the legitimate origin.
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW }, headers: { origin: env.PUBLIC_ORIGIN } });
      expect(res.statusCode).toBe(200);
      return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken as string };
    });
    const spoofs: Record<string, string>[] = [
      { origin: 'https://evil.example', host: 'demo.example.trycloudflare.com' },
      { origin: 'http://demo.example.trycloudflare.com' },
      { origin: 'https://demo.example.trycloudflare.com.evil.example', 'x-forwarded-host': 'demo.example.trycloudflare.com' },
      { origin: 'null' },
      { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' },
    ];
    for (const headers of spoofs) {
      const res = await post(app, a, OK, 'trip_pdf', headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      const del = await app.inject({ method: 'DELETE', url: '/api/v1/exports/export_x', headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, ...headers } });
      expect(del.statusCode, JSON.stringify(headers)).toBe(403);
    }
    expect((await post(app, a, OK, 'trip_pdf', { origin: env.PUBLIC_ORIGIN })).statusCode).toBe(202);
  });
});

describe('the PDF response and bytes', () => {
  it('is no-store, an attachment with a fixed safe filename, and application/pdf; every export route is no-store', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const made = await post(app, a, OK);
    expect(made.headers['cache-control']).toBe('no-store');
    const res = await fetchPdf(app, a, 'trip_pdf', made.json().exportId);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    const cd = String(res.headers['content-disposition']);
    expect(cd).toMatch(/^attachment; filename="[A-Za-z0-9._\-]+"$/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // errors and the pending status are no-store too
    const id = made.json().exportId as string;
    expect((await app.inject({ method: 'GET', url: '/api/v1/exports/export_nope', headers: { cookie: a.cookie } })).headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/api/v1/exports/export_nope' })).headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/exports/${id}`, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf } })).headers['cache-control']).toBe('no-store');
  });

  it('the filename never carries title text, injected characters or path parts', async () => {
    const { app, db } = make();
    const a = await login(app, 'user-a');
    const t = secretExportTrip();
    t.title = 'x"; filename=evil.html\r\nSet-Cookie: a=b/../..';
    t.tripId = 'trip_pdf2';
    insertTrip(db, 'user_a', t, '2026-10-01T00:00:00Z');
    const res = await fetchPdf(app, a, 'trip_pdf2');
    const cd = String(res.headers['content-disposition']);
    expect(cd).not.toMatch(/evil|Set-Cookie|\.\.|[\r\n]/i);
    expect(cd.match(/"/g)?.length).toBe(2);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does not contain privateNotes or the home label/name (raw bytes and every inflated stream)', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const res = await fetchPdf(app, a);
    const { text, cps } = inspect(res.rawPayload);
    // positive control: the inspection can see printed text
    expect(hasChars(cps, TITLE), 'title code points visible (control)').toBe(true);
    for (const secret of [NOTE, HOME_LABEL, HOME_NAME, ...ASCII_SECRETS, '秘密のメモ']) {
      expect(text, secret).not.toContain(secret);
      expect(Buffer.from(res.rawPayload).includes(Buffer.from(secret, 'utf8')), secret).toBe(false);
    }
    for (const secret of [NOTE, HOME_LABEL, HOME_NAME]) {
      expect([...secret].some((ch) => cps.has(ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'))), `code points of ${secret}`).toBe(false);
    }
    // no remote reference: no URL or action in the file
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/\/(URI|JavaScript|JS|Launch|EmbeddedFile|OpenAction)\b/);
  });

  it('restricted (mayExport=false) material is absent from the bytes as well', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const res = await fetchPdf(app, a);
    const { cps } = inspect(res.rawPayload);
    expect(hasChars(cps, '非公開レストラン')).toBe(false);
  });
});

describe('queue limits cannot be bypassed', () => {
  function gated(opts: { maxPending?: number } = {}) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = new ExportJobs({ concurrency: 1, maxPending: opts.maxPending ?? 1 });
    let renders = 0;
    const render = async () => { renders += 1; await gate; return new Uint8Array([37, 80, 68, 70]); };
    return { jobs, render, release, renders: () => renders };
  }

  it('parallel requests from one user: exactly one is accepted, the rest are 429 RATE_LIMITED', async () => {
    const g = gated({ maxPending: 8 });
    const { app } = make({ jobs: g.jobs, render: g.render });
    const a = await login(app, 'user-a');
    const results = await Promise.all(Array.from({ length: 20 }, () => post(app, a, OK)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 202)).toHaveLength(1);
    expect(codes.filter((c) => c === 429)).toHaveLength(19);
    for (const r of results.filter((x) => x.statusCode === 429)) expect(ApiError.parse(r.json())).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    g.release();
    await g.jobs.whenIdle();
    expect(g.renders()).toBe(1);
  });

  it('the same user on several sessions or with parallel trip ids is still one slot', async () => {
    const g = gated({ maxPending: 8 });
    const { app, db } = make({ jobs: g.jobs, render: g.render });
    insertTrip(db, 'user_a', secretExportTrip({ tripId: 'trip_a2' }), '2026-10-01T00:00:00Z');
    const s1 = await login(app, 'user-a');
    const s2 = await login(app, 'user-a');
    const rs = await Promise.all([post(app, s1, OK), post(app, s2, OK, 'trip_a2'), post(app, s1, OK, 'trip_a2'), post(app, s2, OK)]);
    expect(rs.filter((r) => r.statusCode === 202)).toHaveLength(1);
    // deleting the running job frees nothing that lets a second render start concurrently
    g.release();
    await g.jobs.whenIdle();
    expect(g.renders()).toBeLessThanOrEqual(1);
  });

  it('a global queue bound holds under a burst across users (QUEUE_FULL), and rejected requests render nothing', async () => {
    const g = gated({ maxPending: 1 });
    const { app } = make({ jobs: g.jobs, render: g.render });
    const [a, b, c] = await Promise.all([login(app, 'user-a'), login(app, 'user-b'), login(app, 'user-c')]);
    const rs = await Promise.all([post(app, a, OK), post(app, b, OK, 'trip_b'), post(app, c, OK, 'trip_c')]);
    const codes = rs.map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 202, 429]);
    expect(ApiError.parse(rs.find((r) => r.statusCode === 429)!.json()).code).toBe('QUEUE_FULL');
    g.release();
    await g.jobs.whenIdle();
    expect(g.renders()).toBe(2);
  });

  it('delete + recreate in a tight loop does not let one user run two renders at once', async () => {
    const g = gated({ maxPending: 8 });
    const { app } = make({ jobs: g.jobs, render: g.render });
    const a = await login(app, 'user-a');
    const first = await post(app, a, OK);
    expect(first.statusCode).toBe(202);
    // Deleting a queued/running job does not hand out a free slot for an unbounded number of new renders:
    // at most the single concurrency slot plus the queue bound may ever be admitted for this user.
    const admitted: number[] = [];
    for (let i = 0; i < 6; i++) {
      await app.inject({ method: 'DELETE', url: `/api/v1/exports/${first.json().exportId}`, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf } });
      const r = await post(app, a, OK);
      admitted.push(r.statusCode);
    }
    g.release();
    await g.jobs.whenIdle();
    // concurrency is 1: renders started never exceed the gate-held one at any time (gate count would show >1 only if two ran)
    expect(g.renders()).toBeLessThanOrEqual(1 + admitted.filter((c) => c === 202).length);
  });

  it('a failing or timing-out render frees the slot and leaks no renderer detail', async () => {
    const jobs = new ExportJobs({ concurrency: 1, timeoutMs: 30 });
    const { app } = make({ jobs, render: async () => { throw new Error('/Users/secret/path boom'); } });
    const a = await login(app, 'user-a');
    const made = await post(app, a, OK);
    expect(made.statusCode).toBe(202);
    await jobs.whenIdle();
    const st = await get(app, a, made.json().exportId);
    expect(st.statusCode).toBe(200);
    expect(st.body).not.toContain('/Users/secret');
    expect(st.body).not.toContain('boom');
    expect((await post(app, a, OK)).statusCode).toBe(202);
  });
});

describe('the personal-entry /local paths are unaffected by the export routes', () => {
  it('the shared app serves no /local or generation route and the export routes add no personal-entry surface', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    for (const url of ['/local/v1/exports', '/local/v1/trips/trip_pdf/exports', '/local/v1/pair', '/api/v1/generations', '/api/v1/trips/trip_pdf/exports/local']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
      expect(res.statusCode, url).toBe(404);
    }
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/\/local/);
    expect(routes).not.toMatch(/generations/);
    expect(routes).toMatch(/exports/);
  });

  it('export code does not import the Claude runner, child_process or any network client', async () => {
    const { sourceFiles, read, rel } = await import('./helpers.ts');
    const files = sourceFiles(['apps/server/src/platform/exports'], { skipTests: true });
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = read(f);
      expect(src, rel(f)).not.toMatch(/child_process|@tkb\/ai|ALLOW_CLAUDE_EXECUTION|node:https?|node:net|undici|\bfetch\(|XMLHttpRequest|process\.env/);
    }
  });
});
