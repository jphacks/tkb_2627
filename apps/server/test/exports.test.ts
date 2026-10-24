import { inflateSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { ApiError, ExportStatus } from '@tkb/contracts';
import { createUser, insertTrip, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';
import { ExportJobs, type ExportJobOptions } from '../src/platform/exports/jobs.ts';
import { buildPrintModel, formatMoney } from '../src/platform/exports/print-model.ts';
import { renderPdf, sanitize } from '../src/platform/exports/pdf.ts';
import type { ExportsDeps } from '../src/platform/exports/index.ts';
import { exportTrip } from './exports-fixture.ts';

const PW = 'correct horse battery';
const apps: ReturnType<typeof buildApp>[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type App = ReturnType<typeof buildApp>;
interface Session { cookie: string; csrf: string }
const cfg = () => ({ ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' });

function make(deps: ExportsDeps = {}, jobOptions: ExportJobOptions = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b', 'user_c']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: new Date().toISOString() });
  }
  const now = '2026-10-01T00:00:00Z';
  insertTrip(db, 'user_a', exportTrip(), now);
  insertTrip(db, 'user_b', exportTrip({ tripId: 'trip_b' }), now);
  insertTrip(db, 'user_c', exportTrip({ tripId: 'trip_c' }), now);
  const jobs = deps.jobs ?? new ExportJobs(jobOptions);
  const app = buildApp({ config: cfg(), db, exports: { ...deps, jobs } });
  apps.push(app);
  return { app, db, jobs };
}
async function login(app: App, loginId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  expect(res.statusCode).toBe(200);
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}
const call = (app: App, s: Session, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
const create = (app: App, s: Session, tripId = 'trip_pdf', body: object = { expectedRevision: 1, format: 'pdf' }) =>
  call(app, s, 'POST', `/api/v1/trips/${tripId}/exports`, body);
const code = (res: { json(): unknown }) => ApiError.parse(res.json()).code;

/** Decompresses every Flate stream so the ToUnicode map and font program can be inspected. */
function streams(pdf: Buffer): string {
  const out: string[] = [];
  const raw = pdf.toString('latin1');
  let from = 0;
  for (;;) {
    const s = raw.indexOf('stream\n', from);
    if (s < 0) break;
    const end = raw.indexOf('endstream', s + 7);
    if (end < 0) break;
    try {
      out.push(inflateSync(pdf.subarray(s + 7, end)).toString('latin1'));
    } catch {
      /* not a flate stream */
    }
    from = end + 'endstream'.length;
  }
  return out.join('\n');
}
const hex = (ch: string) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');

describe('E02 print model (fixed layout, no network)', () => {
  const model = buildPrintModel(exportTrip(), new Date('2026-10-25T03:00:00Z'));
  const text = model.lines.map((l) => l.text).join('\n');

  it('shows local times in the item zone and the trip header', () => {
    expect(model.lines[0]).toEqual({ style: 'title', text: '金沢の秋旅' });
    expect(text).toContain('10:00〜11:30  [訪問] 兼六園を歩く（固定予定）');
    expect(text).toContain('11月1日（日）');
    expect(text).toContain('出力: 2026-10-25 12:00 (Asia/Tokyo)');
  });
  it('writes unknown values as 未定/不明, never 0', () => {
    expect(text).toContain('時刻未定  [食事] 昼食');
    expect(text).toContain('費用: 不明');
    expect(text).toContain('運賃・料金: 不明');
    expect(text).toContain('乗り場: 不明');
    expect(text).toContain('降車: 不明');
    expect(text).toContain('乗車: 金沢駅');
    expect(text).toContain('営業時間: 不明');
    expect(text).toContain('JPY: 320 JPY');
    // act_secret, leg_known fare and the withheld leg are unknown
    expect(text).toContain('費用が不明な項目: 3件');
    expect(text).not.toMatch(/(^|[^0-9,])0 JPY/);
    expect(formatMoney(null)).toBe('不明');
    const empty = buildPrintModel(exportTrip({ days: [] }), new Date());
    expect(empty.lines.map((l) => l.text)).toContain('分かっている費用: なし');
  });
  it('withholds mayExport=false places, legs and photos and lists them', () => {
    expect(model.withheld.map(({ kind, id }) => `${kind}:${id}`).sort()).toEqual(['leg:leg_no', 'photo:p_no', 'place:p_no']);
    expect(text).not.toContain('非公開レストラン');
    expect(text).not.toContain('999');
    expect(text).toContain('出力できない項目');
    expect(text).toContain('（出力できない場所）');
    expect(model.nothingExportable).toBe(false);
  });
  it('never writes the home name, private notes, photos or map images', () => {
    expect(text).not.toContain('自宅');
    expect(text).toContain('出発地 → 兼六園');
    expect(text).not.toContain('秘密のメモ');
    expect(text).not.toContain('https://');
    expect(text).toContain('写真 1件は印刷版に含めていません');
    expect(text).toContain('地図画像は含みません');
    expect(text).toContain('出典');
    expect(text).toContain('サンプル提供元');
  });
  it('reports nothing exportable when every item is withheld', () => {
    const t = exportTrip();
    const only = buildPrintModel({ ...t, days: [{ ...t.days[0]!, items: [t.days[0]!.items[3]!] }] }, new Date());
    expect(only.nothingExportable).toBe(true);
  });
  it('sanitizes control characters and glyphs the font lacks', () => {
    expect(sanitize('a\nb\u0007c😀金')).toBe('a bc?金');
  });
});

describe('E02 PDF rendering', () => {
  it('embeds a subset Japanese font and paginates long trips', async () => {
    const t = exportTrip();
    const items = Array.from({ length: 120 }, (_, i) => ({ ...(t.days[0]!.items[1] as object), activityId: `a${i}` }));
    const model = buildPrintModel({ ...t, days: [{ ...t.days[0]!, items: items as never }] }, new Date());
    const bytes = Buffer.from(await renderPdf(model.lines, { footer: 'テスト' }));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2);
    expect(bytes.length).toBeLessThan(2_000_000); // subset, not the 2.5 MB face
  });
});

describe('E02 K18 PDF export routes', () => {
  it('owner creates and fetches a PDF with the Japanese title embedded', async () => {
    const { app, jobs } = make();
    const a = await login(app, 'user-a');
    const res = await create(app, a, 'trip_pdf', { tripId: 'trip_pdf', expectedRevision: 1, format: 'pdf' });
    expect(res.statusCode).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    const st = ExportStatus.parse(res.json());
    expect(st.status).toBe('queued');
    expect(st.withheld?.map((w) => w.kind).sort()).toEqual(['leg', 'photo', 'place']);
    await jobs.whenIdle();
    const file = await call(app, a, 'GET', `/api/v1/exports/${st.exportId}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe('attachment; filename="trip-trip_pdf.pdf"');
    expect(file.headers['cache-control']).toBe('no-store');
    const pdf = file.rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const decoded = streams(pdf); // dictionaries live in compressed object streams
    expect(decoded).toMatch(/\/FontFile2/);
    expect(decoded).toMatch(/NotoSansJP/);
    for (const ch of '金沢の秋旅') expect(decoded).toContain(`<${hex(ch)}>`);
    expect((await PDFDocument.load(pdf)).getTitle()).toBe('金沢の秋旅');
  });

  it('another user and anonymous cannot create or fetch; missing ids are 404', async () => {
    const { app, jobs } = make();
    const a = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    expect((await create(app, b, 'trip_pdf')).statusCode).toBe(404);
    expect((await create(app, a, 'trip_missing')).statusCode).toBe(404);
    const st = ExportStatus.parse((await create(app, a)).json());
    await jobs.whenIdle();
    const other = await call(app, b, 'GET', `/api/v1/exports/${st.exportId}`);
    expect(other.statusCode).toBe(404);
    expect(code(other)).toBe('NOT_FOUND');
    expect((await call(app, b, 'DELETE', `/api/v1/exports/${st.exportId}`)).statusCode).toBe(404);
    expect((await call(app, a, 'GET', '/api/v1/exports/export_nope')).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/exports/${st.exportId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/trips/trip_pdf/exports', payload: { expectedRevision: 1, format: 'pdf' } })).statusCode).toBe(401);
    // still fetchable by the owner
    expect((await call(app, a, 'GET', `/api/v1/exports/${st.exportId}`)).headers['content-type']).toBe('application/pdf');
  });

  it('rejects a POST without the CSRF token', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const res = await app.inject({ method: 'POST', url: '/api/v1/trips/trip_pdf/exports', payload: { expectedRevision: 1, format: 'pdf' }, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('409 on a stale revision', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const res = await create(app, a, 'trip_pdf', { expectedRevision: 2, format: 'pdf' });
    expect(res.statusCode).toBe(409);
    expect(ApiError.parse(res.json())).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 2, currentRevision: 1 } });
  });

  it('accepts no URL, HTML or other format input (strict body)', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    for (const body of [
      { expectedRevision: 1, format: 'pdf', url: 'https://example.com' },
      { expectedRevision: 1, format: 'pdf', html: '<h1>x</h1>' },
      { expectedRevision: 1, format: 'pdf', template: 'x' },
      { expectedRevision: 1, format: 'html' },
      { expectedRevision: 1, format: 'ics' },
      { expectedRevision: 1, format: 'pdf', tripId: 'trip_b' },
      { format: 'pdf' },
    ]) {
      const res = await create(app, a, 'trip_pdf', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
  });

  it('422 RESTRICTED_ASSET only when nothing may be exported', async () => {
    const { app, db } = make();
    const t = exportTrip({ tripId: 'trip_restricted' });
    insertTrip(db, 'user_a', { ...t, days: [{ ...t.days[0]!, items: [t.days[0]!.items[3]!] }] }, '2026-10-01T00:00:00Z');
    const a = await login(app, 'user-a');
    const res = await create(app, a, 'trip_restricted');
    expect(res.statusCode).toBe(422);
    expect(ApiError.parse(res.json())).toMatchObject({ code: 'RESTRICTED_ASSET', details: { withheld: [{ kind: 'leg', id: 'leg_no' }] } });
  });

  it('a job over the timeout becomes failed', async () => {
    const { app, jobs } = make({ render: () => new Promise<Uint8Array>(() => {}) }, { timeoutMs: 30 });
    const a = await login(app, 'user-a');
    const st = ExportStatus.parse((await create(app, a)).json());
    await jobs.whenIdle();
    const res = await call(app, a, 'GET', `/api/v1/exports/${st.exportId}`);
    expect(res.statusCode).toBe(200);
    expect(ExportStatus.parse(res.json())).toMatchObject({ status: 'failed', url: null, error: { code: 'TIMEOUT' } });
    // the slot is free again
    expect((await create(app, a)).statusCode).toBe(202);
  });

  it('one export in flight per user (429 RATE_LIMITED) and a bounded queue (429 QUEUE_FULL)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, jobs } = make({ render: async () => (await gate, new Uint8Array([37, 80, 68, 70])) }, { concurrency: 1, maxPending: 1 });
    const a = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    const c = await login(app, 'user-c');
    expect((await create(app, a)).statusCode).toBe(202); // running
    const again = await create(app, a);
    expect(again.statusCode).toBe(429);
    expect(ApiError.parse(again.json())).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    const queued = await create(app, b, 'trip_b');
    expect(queued.statusCode).toBe(202); // waiting
    expect(ExportStatus.parse((await call(app, b, 'GET', `/api/v1/exports/${queued.json().exportId}`)).json()).status).toBe('queued');
    const full = await create(app, c, 'trip_c');
    expect(full.statusCode).toBe(429);
    expect(code(full)).toBe('QUEUE_FULL');
    release();
    await jobs.whenIdle();
    expect((await call(app, b, 'GET', `/api/v1/exports/${queued.json().exportId}`)).headers['content-type']).toBe('application/pdf');
  });

  it('404 after the trip or the export is deleted; expired files are dropped', async () => {
    let now = Date.parse('2026-10-25T00:00:00Z');
    const { app, db, jobs } = make({}, { now: () => now, ttlMs: 60_000 });
    const a = await login(app, 'user-a');
    const first = ExportStatus.parse((await create(app, a)).json());
    await jobs.whenIdle();
    expect((await call(app, a, 'DELETE', `/api/v1/exports/${first.exportId}`)).statusCode).toBe(204);
    expect((await call(app, a, 'GET', `/api/v1/exports/${first.exportId}`)).statusCode).toBe(404);

    const second = ExportStatus.parse((await create(app, a)).json());
    await jobs.whenIdle();
    now += 61_000;
    const expired = await call(app, a, 'GET', `/api/v1/exports/${second.exportId}`);
    expect(ExportStatus.parse(expired.json())).toMatchObject({ status: 'expired', url: null });

    const third = ExportStatus.parse((await create(app, a)).json());
    await jobs.whenIdle();
    db.prepare("UPDATE trips SET deleted_at = '2026-10-25T00:00:00Z' WHERE id = 'trip_pdf'").run();
    expect((await call(app, a, 'GET', `/api/v1/exports/${third.exportId}`)).statusCode).toBe(404);
    expect((await create(app, a)).statusCode).toBe(404);
  });
});
