import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PlaceInfo, TravelLeg, Trip } from '@tkb/contracts';
import { domesticTrip, overseasTrip } from '@tkb/fixtures';
import { createMockApi } from '../../mocks/index.ts';
import { fetchTrip, fetchTripFromMock, tripUrl } from './api.ts';
import { AttributionBlock, ItineraryBody, ItineraryView, TimelineItem } from './ItineraryScreen.tsx';
import { StaticMap } from './MapPanel.tsx';
import { readBrowserMapsKey } from './mapsKey.ts';
import {
  attributionFor, dayTransportMode, formatLocalTime, mapPoints, syncSelection, timelineRows, toggleSelection, transitDetail, unlocatedPlaces,
} from './model.ts';
import { itineraryHash, parseItineraryHash } from './route.ts';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const noop = () => {};
/** A zero shown as money or duration: ¥0 / 0円 / €0 / 0分. */
const SHOWN_AS_ZERO = /[¥￥€]\s?0(?![\d,.])|(?<![\d,.:])0(円|分)/;
const clone = (t: Trip): Trip => structuredClone(t);

function unknownLeg(overrides: Partial<TravelLeg> = {}): TravelLeg {
  return {
    type: 'leg', legId: 'leg_u', mode: 'transit', fromPlaceId: 'fx_kenrokuen', toPlaceId: 'fx_21c_museum',
    departure: null, arrival: null, durationSeconds: null, lineName: null, platform: null, transfers: null, fare: null,
    dataStatus: 'unknown', provenance: null, transit: null, ...overrides,
  };
}

function tripWithItems(items: Trip['days'][number]['items']): Trip {
  const t = clone(domesticTrip);
  t.days = [{ date: '2026-11-01', timeZone: 'Asia/Tokyo', items }];
  return t;
}

describe('unknown values are never shown as 0', () => {
  it('a leg with null fare/duration/times renders 不明 / 未定', () => {
    const trip = tripWithItems([unknownLeg()]);
    const [row] = timelineRows(trip.days[0]!, trip.places);
    const html = render(<TimelineItem row={row!} selected={false} onSelect={noop} />);
    expect(html.replace(/<[^>]+>/g, '')).toContain('未定 〜 未定');
    expect(html).toContain('所要 <span class="u1-unknown">不明</span>');
    expect(html).toContain('運賃 <span class="u1-unknown">不明</span>');
    expect(html).toContain('ホーム <span class="u1-unknown">不明</span>');
    expect(html).not.toMatch(SHOWN_AS_ZERO);
  });

  it('the whole Kanazawa fixture view (unknown admission, untimed leg) shows no 0 for unknowns', () => {
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(html).toContain('不明');
    expect(html).toContain('未定');
    expect(html).not.toMatch(SHOWN_AS_ZERO);
  });

  it('a known 0-transfer count is shown as 0回, but null transfers is 不明', () => {
    expect(transitDetail(unknownLeg({ transfers: 0 }))?.transferCount).toBe('0回');
    expect(transitDetail(unknownLeg())?.transferCount).toBe('不明');
  });
});

describe('local time per IANA zone', () => {
  it('shows the time in the item zone (Tokyo, Paris across the DST end)', () => {
    expect(formatLocalTime({ utc: '2026-11-01T00:30:00Z', timeZone: 'Asia/Tokyo' }, '2026-11-01')).toMatch(/^09:30 (JST|GMT\+9)$/);
    // 2026-10-25: CEST until 01:00Z, CET afterwards.
    expect(formatLocalTime({ utc: '2026-10-25T00:30:00Z', timeZone: 'Europe/Paris' }, '2026-10-25')).toMatch(/^02:30 /);
    expect(formatLocalTime({ utc: '2026-10-25T01:30:00Z', timeZone: 'Europe/Paris' }, '2026-10-25')).toMatch(/^02:30 /);
    expect(formatLocalTime({ utc: '2026-10-25T00:30:00Z', timeZone: 'Europe/Paris' }, '2026-10-25'))
      .not.toBe(formatLocalTime({ utc: '2026-10-25T01:30:00Z', timeZone: 'Europe/Paris' }, '2026-10-25'));
  });

  it('prefixes the date when the local date is not the day date, and null is 未定', () => {
    expect(formatLocalTime({ utc: '2026-11-01T16:00:00Z', timeZone: 'Asia/Tokyo' }, '2026-11-01')).toMatch(/^11\/2 01:00 /);
    expect(formatLocalTime(null, '2026-11-01')).toBe('未定');
  });

  it('the overseas fixture renders Paris times, not the viewer zone', () => {
    const html = render(<ItineraryView trip={overseasTrip} source="server" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(html).toContain('Europe/Paris');
  });
});

describe('per-day transport mode (R06)', () => {
  it('uses transportModeByDate, else the trip mode', () => {
    const t = clone(domesticTrip);
    t.constraints.transportModeByDate = { '2026-11-02': 'car' };
    expect(dayTransportMode(t, '2026-11-01')).toBe('transit');
    expect(dayTransportMode(t, '2026-11-02')).toBe('car');
    const html = render(<ItineraryView trip={t} source="server" dayIndex={1} onSelectDay={noop} mapsKey={null} />);
    expect(html).toContain('この日の移動手段：<strong>車</strong>');
  });
});

describe('transit details (R05)', () => {
  it('shows line, boarding/alighting and transfer stops when present', () => {
    const trip = tripWithItems([unknownLeg({
      lineName: '北鉄バス', platform: '3', transfers: 1,
      transit: { boardingStop: '金沢駅東口', alightingStop: '兼六園下', transferStops: ['香林坊'] },
    })]);
    const [row] = timelineRows(trip.days[0]!, trip.places);
    const html = render(<TimelineItem row={row!} selected={false} onSelect={noop} />);
    for (const s of ['北鉄バス', '金沢駅東口', '兼六園下', '香林坊', '1回']) expect(html).toContain(s);
  });
});

describe('selection sync (R08)', () => {
  const day = domesticTrip.days[0]!;
  it('timeline -> map: selecting a leg highlights both of its places', () => {
    const s = syncSelection({ kind: 'item', key: 'fx_leg_1' }, day);
    expect([...s.placeIds].sort()).toEqual(['fx_kanazawa_station', 'fx_kenrokuen']);
    expect(s.focusItemKey).toBe('fx_leg_1');
  });
  it('map -> timeline: selecting a place highlights its items and opens the first one', () => {
    const s = syncSelection({ kind: 'place', placeId: 'fx_kenrokuen' }, day);
    expect([...s.itemKeys]).toEqual(expect.arrayContaining(['fx_leg_1', 'fx_act_kenrokuen', 'fx_leg_2']));
    expect(s.focusItemKey).toBe('fx_leg_1');
  });
  it('no selection highlights nothing; selecting again clears', () => {
    const s = syncSelection(null, day);
    expect(s.itemKeys.size + s.placeIds.size).toBe(0);
    expect(s.focusItemKey).toBeNull();
    expect(toggleSelection({ kind: 'place', placeId: 'a' }, { kind: 'place', placeId: 'a' })).toBeNull();
    expect(toggleSelection({ kind: 'place', placeId: 'a' }, { kind: 'item', key: 'a' })).toEqual({ kind: 'item', key: 'a' });
  });
  it('the rendered view marks the selected item and its map points', () => {
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null}
      initialSelection={{ kind: 'place', placeId: 'fx_kenrokuen' }} />);
    expect(html).toMatch(/class="it-point it-on" aria-pressed="true"/);
    expect(html).toContain('（選択中）');
    expect((html.match(/class="it-item[^"]*it-on"/g) ?? []).length).toBe(3);
  });
  it('places without a location are not put on the map (never at 0,0)', () => {
    const t = clone(domesticTrip);
    t.places = t.places.map((p: PlaceInfo) => (p.placeId === 'fx_kenrokuen' ? { ...p, location: null } : p));
    const points = mapPoints(t.days[0]!, t.places);
    expect(points.find(p => p.placeId === 'fx_kenrokuen')).toBeUndefined();
    expect(unlocatedPlaces(t.days[0]!, t.places).map(p => p.name)).toHaveLength(1);
  });
});

describe('map without a key, attribution', () => {
  it('readBrowserMapsKey: empty or missing is null; only PUBLIC_MAPS_BROWSER_KEY is read', () => {
    expect(readBrowserMapsKey({})).toBeNull();
    expect(readBrowserMapsKey({ PUBLIC_MAPS_BROWSER_KEY: '  ' })).toBeNull();
    expect(readBrowserMapsKey({ GOOGLE_MAPS_SERVER_KEY: 'server-key' })).toBeNull();
    expect(readBrowserMapsKey({ PUBLIC_MAPS_BROWSER_KEY: 'browser-test' })).toBe('browser-test');
  });

  it('no key renders the static fallback (地図キー未設定) with numbered places, without loading Google', () => {
    const before = typeof document;
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(html).toContain('地図キー未設定');
    expect(html).toContain('data-testid="map-fallback"');
    expect(html).not.toContain('maps.googleapis.com');
    expect(typeof document).toBe(before); // nothing injected a script into a DOM in the node test environment
    const fb = render(<StaticMap points={mapPoints(domesticTrip.days[0]!, domesticTrip.places)} highlighted={new Set()} onSelectPlace={noop} reason="地図キー未設定" />);
    expect(fb).toContain('金沢駅');
  });

  it('attribution is shown: fixture data, provider credits, photo authors, Google when Google data is used', () => {
    const fixtureHtml = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(fixtureHtml).toContain('aria-label="出典"');
    expect(fixtureHtml).toContain('サンプルデータ（fixture）');

    const t = clone(domesticTrip);
    t.places = t.places.map((p, i) => i === 0 ? {
      ...p,
      provenance: { ...p.provenance, source: 'google_places', attribution: '提供: 例の店舗情報' },
      photo: { url: 'https://example.com/p.jpg', attribution: '撮影: 山田', license: null },
    } : p);
    const a = attributionFor(t);
    expect(a.usesGoogle).toBe(true);
    const noMap = render(<AttributionBlock attribution={a} mapShown={false} />);
    expect(noMap).toContain('Google Maps');
    expect(noMap).toContain('提供: 例の店舗情報');
    expect(noMap).toContain('撮影: 山田');
    const withMap = render(<AttributionBlock attribution={a} mapShown />);
    expect(withMap).toContain('© Google');
  });
});

describe('reload reads what the server saved (K09)', () => {
  it('fetchTrip calls GET /api/v1/trips/{id} without cache and validates with the Trip schema', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(domesticTrip), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await fetchTrip('fx_trip_kanazawa', { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/trips/fx_trip_kanazawa');
    expect(init.cache).toBe('no-store');
    expect(r).toMatchObject({ state: 'ok', source: 'server', trip: { tripId: 'fx_trip_kanazawa' } });
  });

  it('each load fetches again, so a reload shows the newer saved revision', async () => {
    let revision = 1;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...domesticTrip, revision }), { status: 200 }));
    const first = await fetchTrip('fx_trip_kanazawa', { fetch: fetchMock });
    revision = 2;
    const second = await fetchTrip('fx_trip_kanazawa', { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.state === 'ok' && first.trip.revision).toBe(1);
    expect(second.state === 'ok' && second.trip.revision).toBe(2);
  });

  it('maps 404, 401, API errors and schema mismatch to screen states', async () => {
    const res = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    expect((await fetchTrip('x', { fetch: res(404, {}) })).state).toBe('notFound');
    expect((await fetchTrip('x', { fetch: res(401, {}) })).state).toBe('unauthenticated');
    const err = await fetchTrip('x', { fetch: res(503, { code: 'PROVIDER_UNAVAILABLE', message: '停止中', retryable: true, requestId: 'req_1' }) });
    expect(err).toMatchObject({ state: 'error', message: '停止中', requestId: 'req_1' });
    const bad = await fetchTrip('x', { fetch: res(200, { ...domesticTrip, days: 'nope' }) });
    expect(bad).toMatchObject({ state: 'error' });
    const net = await fetchTrip('x', { fetch: vi.fn(async () => { throw new TypeError('network down'); }) });
    expect(net).toMatchObject({ state: 'error', message: 'network down' });
    expect(tripUrl('a b')).toBe('/api/v1/trips/a%20b');
  });

  it('mock mode reads the mock API (ok, 404, error scenario)', async () => {
    expect((await fetchTripFromMock(createMockApi(), 'fx_trip_kanazawa')).state).toBe('ok');
    expect((await fetchTripFromMock(createMockApi(), 'nope')).state).toBe('notFound');
    expect((await fetchTripFromMock(createMockApi({ scenario: 'error' }), 'fx_trip_kanazawa')).state).toBe('error');
  });

  it('hash route keeps trip id and day across reloads', () => {
    expect(parseItineraryHash('#/trips/fx_trip_kanazawa/map')).toEqual({ mode: 'server', tripId: 'fx_trip_kanazawa', dayIndex: 0 });
    expect(parseItineraryHash('#/mock/trips/fx_trip_paris/map?day=1')).toEqual({ mode: 'mock', tripId: 'fx_trip_paris', dayIndex: 1 });
    expect(parseItineraryHash('#/trips/../map')).toBeNull();
    expect(parseItineraryHash('#dev-shell')).toBeNull();
    expect(itineraryHash({ mode: 'server', tripId: 't1', dayIndex: 2 })).toBe('#/trips/t1/map?day=2');
  });
});

describe('screen states', () => {
  const body = (load: Parameters<typeof ItineraryBody>[0]['load']) =>
    render(<ItineraryBody load={load} dayIndex={0} onSelectDay={noop} onRetry={noop} mapsKey={null} />);
  it('loading / 404 / 401 / error / empty', () => {
    expect(body(null)).toContain('読み込み中');
    expect(body({ state: 'notFound', source: 'server' })).toContain('404');
    expect(body({ state: 'unauthenticated', source: 'server' })).toContain('ログインが必要');
    const e = body({ state: 'error', message: '停止中', code: 'PROVIDER_UNAVAILABLE', source: 'server' });
    expect(e).toContain('停止中');
    expect(e).toContain('再試行');
    const empty = clone(domesticTrip);
    empty.days = [];
    expect(body({ state: 'ok', trip: empty, source: 'server' })).toContain('まだ日程がありません');
    const emptyDay = tripWithItems([]);
    expect(body({ state: 'ok', trip: emptyDay, source: 'server' })).toContain('この日の予定はありません');
  });
  it('labels server data vs mock data', () => {
    expect(body({ state: 'ok', trip: domesticTrip, source: 'server' })).toContain('サーバー保存データ');
    expect(body({ state: 'ok', trip: domesticTrip, source: 'mock' })).toContain('モックデータ');
  });
});
