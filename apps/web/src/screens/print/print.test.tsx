import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TravelLeg, Trip } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { PrintSheet } from './PrintScreen.tsx';
import { PHOTO_PLACEHOLDER, buildPrintModel, costText, printablePhoto } from './model.ts';
import { BASE_DELAY_MS, MAX_DELAY_MS, MAX_TRIES, PDF_MESSAGES, backoffMs, createMockPdf, createPdf } from './pdf.ts';
import { parsePrintHash } from './route.ts';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const clone = (t: Trip): Trip => structuredClone(t);
const SHOWN_AS_ZERO = /[¥￥€]\s?0(?![\d,.])|(?<![\d,.:])0(円|分)/;

function withPhoto(mayExport: boolean, attribution: string): Trip {
  const t = clone(domesticTrip);
  const place = t.places[0]!;
  place.photo = { url: 'https://example.test/p.jpg', attribution, license: 'CC BY' };
  place.provenance.mayExport = mayExport;
  // make sure an activity uses this place
  const act = t.days[0]!.items.find(i => i.type === 'activity')!;
  if (act.type === 'activity') act.placeId = place.placeId;
  return t;
}

function unknownLeg(): TravelLeg {
  return {
    type: 'leg', legId: 'leg_u', mode: 'transit', fromPlaceId: domesticTrip.places[0]!.placeId, toPlaceId: domesticTrip.places[1]!.placeId,
    departure: null, arrival: null, durationSeconds: null, lineName: null, platform: null, transfers: null, fare: null,
    dataStatus: 'unknown', provenance: null, transit: null,
  };
}

describe('print model', () => {
  it('unknown values are 未定/不明 and never 0', () => {
    const t = clone(domesticTrip);
    t.days = [{ date: '2026-11-01', timeZone: 'Asia/Tokyo', items: [unknownLeg()] }];
    const html = render(<PrintSheet trip={t} />);
    expect(html).toContain('未定');
    expect(html).toContain('不明');
    expect(html).not.toMatch(SHOWN_AS_ZERO);
    expect(buildPrintModel(t).cost).toEqual({ perCurrency: [], unknownCount: 1 });
    expect(costText(buildPrintModel(t).cost)).toContain('1 件');
  });

  it('sums cost per currency and counts unknown separately', () => {
    const t = clone(domesticTrip);
    const acts = t.days[0]!.items.filter(i => i.type === 'activity');
    acts.forEach((a, i) => { if (a.type === 'activity') a.cost = i === 0 ? null : { currency: 'JPY', amountMinor: 1000 }; });
    const c = buildPrintModel(t).cost;
    expect(c.unknownCount).toBeGreaterThanOrEqual(1);
    expect(c.perCurrency.every(s => /1,000|2,000|3,000/.test(s) || s.includes('￥') || s.includes('¥'))).toBe(true);
  });

  it('photo printed only with mayExport and an author credit', () => {
    const ok = withPhoto(true, '山田太郎');
    expect(printablePhoto(ok.places[0])).toEqual({ url: 'https://example.test/p.jpg', credit: '山田太郎（CC BY）' });
    const html = render(<PrintSheet trip={ok} />);
    expect(html).toContain('<img');
    expect(html).toContain('山田太郎');

    const denied = render(<PrintSheet trip={withPhoto(false, '山田太郎')} />);
    expect(denied).not.toContain('<img');
    expect(denied).not.toContain('example.test');

    const noAuthor = withPhoto(true, '   ');
    expect(printablePhoto(noAuthor.places[0])).toBeNull();
    expect(render(<PrintSheet trip={noAuthor} />)).toContain(PHOTO_PLACEHOLDER);
  });

  it('never renders a map image or iframe', () => {
    const html = render(<PrintSheet trip={withPhoto(true, 'a')} />);
    expect(html).not.toMatch(/maps\.googleapis|staticmap|<iframe|<canvas|tile/i);
    expect(html).toContain('地図画像は掲載していません');
  });

  it('lists sources per item and in the sources list', () => {
    const t = clone(domesticTrip);
    t.places[0]!.provenance.attribution = '© テスト出典';
    const m = buildPrintModel(t);
    expect(m.sources.some(s => s.includes('© テスト出典'))).toBe(true);
    const html = render(<PrintSheet trip={t} />);
    expect(html).toContain('出典・写真クレジット');
    expect(html).toContain('出典: ');
  });

  it('withholds places with mayExport=false', () => {
    const t = clone(domesticTrip);
    const p = t.places[0]!;
    p.provenance.mayExport = false;
    const m = buildPrintModel(t);
    expect(m.places).not.toContain(p.name);
    expect(render(<PrintSheet trip={t} />)).not.toContain(`地点: ${p.name}`);
  });

  it('print css breaks pages per day and avoids splitting items', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('./print.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/\.pr-day\s*\{[^}]*break-before: page/);
    expect(css).toMatch(/\.pr-item[^{]*\{[^}]*break-inside: avoid/);
  });

  it('parses print hashes', () => {
    expect(parsePrintHash('#/trips/abc/print')).toEqual({ mode: 'server', tripId: 'abc' });
    expect(parsePrintHash('#/mock/trips/abc/print')).toEqual({ mode: 'mock', tripId: 'abc' });
    expect(parsePrintHash('#/trips/abc/map')).toBeNull();
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { userId: 'u1', displayName: 'x', csrfToken: 'tok123' };
const queued = { exportId: 'ex1', status: 'queued', url: null, withheld: [{ kind: 'photo', id: 'ph1' }] };
const pdfRes = () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } });

function mkFetch(steps: Array<() => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url === '/api/v1/auth/me') return json(ME);
    const step = steps[Math.min(i++, steps.length - 1)]!;
    return step();
  });
  return { fn, calls };
}

describe('PDF flow', () => {
  const sleep = vi.fn(async () => {});

  it('POST carries the CSRF header and a strict body; ready returns a blob and withheld', async () => {
    const { fn, calls } = mkFetch([() => json(queued, 202), () => json({ ...queued }), pdfRes]);
    const r = await createPdf('trip1', 3, { fetch: fn, sleep });
    expect(r.state).toBe('ready');
    if (r.state === 'ready') expect(r.withheld).toEqual([{ kind: 'photo', id: 'ph1' }]);
    const post = calls.find(c => c.init?.method === 'POST')!;
    expect(post.url).toBe('/api/v1/trips/trip1/exports');
    expect((post.init!.headers as Record<string, string>)['x-csrf-token']).toBe('tok123');
    expect(JSON.parse(post.init!.body as string)).toEqual({ expectedRevision: 3, format: 'pdf' });
  });

  it('failed and expired stop polling', async () => {
    const f = mkFetch([() => json(queued, 202), () => json({ exportId: 'ex1', status: 'failed', url: null, error: { code: 'TIMEOUT', message: '時間切れ' } })]);
    expect(await createPdf('t', 1, { fetch: f.fn, sleep })).toMatchObject({ state: 'failed', message: '時間切れ' });
    const e = mkFetch([() => json(queued, 202), () => json({ exportId: 'ex1', status: 'expired', url: null })]);
    expect((await createPdf('t', 1, { fetch: e.fn, sleep })).state).toBe('expired');
  });

  it('gives up after MAX_TRIES with a capped backoff', async () => {
    const delays: number[] = [];
    const f = mkFetch([() => json(queued, 202), () => json(queued)]);
    const r = await createPdf('t', 1, { fetch: f.fn, sleep: async ms => { delays.push(ms); } });
    expect(r.state).toBe('timeout');
    expect(delays).toHaveLength(MAX_TRIES);
    expect(Math.max(...delays)).toBe(MAX_DELAY_MS);
    expect(delays[0]).toBe(BASE_DELAY_MS);
    expect(backoffMs(100)).toBe(MAX_DELAY_MS);
  });

  it('409 and RESTRICTED_ASSET map to their states', async () => {
    const c = mkFetch([() => json({ code: 'REVISION_CONFLICT', message: 'x', requestId: 'r', retryable: false }, 409)]);
    expect((await createPdf('t', 1, { fetch: c.fn, sleep })).state).toBe('conflict');
    expect(PDF_MESSAGES.conflict).toContain('他の端末で更新されています');
    const r = mkFetch([() => json({ code: 'RESTRICTED_ASSET', message: 'x', requestId: 'r', retryable: false }, 422)]);
    expect((await createPdf('t', 1, { fetch: r.fn, sleep })).state).toBe('restricted');
    expect(PDF_MESSAGES.restricted).toBe('出力できる項目がありません。');
  });

  it('invalid JSON from the server is a contract error, no CSRF means no POST', async () => {
    const bad = mkFetch([() => json({ nope: true }, 202)]);
    expect((await createPdf('t', 1, { fetch: bad.fn, sleep })).state).toBe('error');
    const noAuth = vi.fn(async () => json({}, 401));
    const r = await createPdf('t', 1, { fetch: noAuth, sleep });
    expect(r.state).toBe('error');
    expect(noAuth).toHaveBeenCalledTimes(1);
  });

  it('mock mode returns a tiny pdf blob without network', async () => {
    const r = await createMockPdf();
    expect(r.state).toBe('ready');
    if (r.state === 'ready') expect(r.blob.type).toBe('application/pdf');
  });
});
