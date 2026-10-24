import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { domesticTrip } from '@tkb/fixtures';
import { PrintBody } from './PrintScreen.tsx';
import { fetchIcs, fetchMapsLinks, groupByDay, mockIcs, mockMapsLinks } from './calendar-maps.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (code: string) => ({ code, message: 'm', retryable: false, requestId: 'r', details: { withheld: [{ kind: 'place', id: 'p1' }] } });

describe('E03 client', () => {
  it('fetchIcs returns the blob for text/calendar and sends credentials', async () => {
    const f = vi.fn(async (_i: string, _init?: RequestInit) => new Response('BEGIN:VCALENDAR', { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' } }));
    const r = await fetchIcs('t1', { fetch: f });
    expect(r.state).toBe('ready');
    expect(f.mock.calls[0]![0]).toBe('/api/v1/trips/t1/ics');
    expect(f.mock.calls[0]![1]!.credentials).toBe('same-origin');
  });

  it('maps 401, 404 and 422 RESTRICTED_ASSET; rejects non-calendar bodies', async () => {
    expect((await fetchIcs('t', { fetch: async () => json(401, {}) })).state).toBe('unauthenticated');
    expect((await fetchIcs('t', { fetch: async () => json(404, {}) })).state).toBe('notFound');
    expect((await fetchIcs('t', { fetch: async () => json(422, err('RESTRICTED_ASSET')) })).state).toBe('restricted');
    expect((await fetchIcs('t', { fetch: async () => json(200, {}) })).state).toBe('error');
    expect((await fetchIcs('t', { fetch: async () => { throw new TypeError('x'); } })).state).toBe('error');
  });

  it('fetchMapsLinks groups by day, keeps only Google Maps URLs and returns the withheld list', async () => {
    const body = {
      links: [
        { dayIndex: 1, url: 'https://www.google.com/maps/dir/?api=1&a=b' },
        { dayIndex: 0, url: 'https://www.google.com/maps/search/?api=1&query=x' },
        { dayIndex: 0, url: 'https://evil.example/maps/' },
      ],
      withheld: [{ kind: 'place', id: 'p_no' }],
    };
    const r = await fetchMapsLinks('t1', { fetch: async () => json(200, body) });
    expect(r).toEqual({
      state: 'ready',
      byDay: [
        { dayIndex: 0, urls: ['https://www.google.com/maps/search/?api=1&query=x'] },
        { dayIndex: 1, urls: ['https://www.google.com/maps/dir/?api=1&a=b'] },
      ],
      withheld: [{ kind: 'place', id: 'p_no' }],
    });
    expect(groupByDay([])).toEqual([]);
  });

  it('fetchMapsLinks reports 422 with withheld, and a contract mismatch as error', async () => {
    const r = await fetchMapsLinks('t', { fetch: async () => json(422, err('RESTRICTED_ASSET')) });
    expect(r).toEqual({ state: 'restricted', withheld: [{ kind: 'place', id: 'p1' }] });
    expect((await fetchMapsLinks('t', { fetch: async () => json(200, { links: 1 }) })).state).toBe('error');
  });

  it('mock mode returns small fake data without network', async () => {
    const ics = await mockIcs();
    expect(ics.state === 'ready' && (await ics.blob.text()).startsWith('BEGIN:VCALENDAR')).toBe(true);
    const maps = await mockMapsLinks();
    expect(maps.state === 'ready' && maps.byDay.length).toBe(1);
  });

  it('print screen shows both buttons next to the PDF button', () => {
    const html = renderToString(<PrintBody load={{ state: 'ok', trip: domesticTrip, source: 'mock' } as never} mode="mock" />);
    expect(html).toContain('カレンダー（ICS）をダウンロード');
    expect(html).toContain('Googleマップで開く');
    expect(html).toContain('PDFを作成');
  });
});
