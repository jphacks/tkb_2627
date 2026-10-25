import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { domesticTrip } from '@tkb/fixtures';
import type { GeoLike } from '../travel/geo.ts';
import { mapPoints } from '../itinerary/model.ts';
import { AmenitiesPanel, GuideView, SpotPanel, amenityMarkers } from './GuideScreen.tsx';
import {
  AMENITY_KIND_LABEL, EMPTY_TEXT, SHELTER_WARNING, UNSUPPORTED_TEXT, amenitiesUrl, bboxAround, chooseArea, classifyAmenities, currentDayIndex,
  displayName, fallbackBbox, type AmenityKind, fetchAmenities, mockAmenities, spotDetail, type AmenitiesLoad, type AmenityResponse,
  fetchGuide, guidesUrl, mergeGuide, type GuideLoad,
} from './model.ts';
import type { GuideItem } from '@tkb/contracts';
import { guideHash, parseGuideHash } from './route.ts';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const ALL: ReadonlySet<AmenityKind> = new Set(['toilet', 'evacuation_site', 'evacuation_shelter']);
const trip = domesticTrip;
const day = trip.days[0]!;
const prov = { source: 'fixture:amenities', fetchedAt: '2026-10-24T00:00:00Z', attribution: '架空', maySendToModel: false, mayStore: true, mayExport: false, retainUntil: null };
const resp = (over: Partial<AmenityResponse>): AmenityResponse => ({ items: [], dataStatus: 'fixture', reason: null, fetchedAt: '2026-10-24T00:00:00Z', supportedRegion: '金沢', ...over });
const shelter = { id: 's', kind: 'evacuation_shelter' as const, name: '小学校', location: { lat: 36.5, lng: 136.6 }, openNow: null, warning: '', provenance: prov };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('route', () => {
  it('parses real and mock guide hashes', () => {
    expect(parseGuideHash('#/trips/t_1/guide')).toEqual({ mode: 'server', tripId: 't_1' });
    expect(parseGuideHash('#/mock/trips/t_1/guide')).toEqual({ mode: 'mock', tripId: 't_1' });
    expect(parseGuideHash('#/trips/t_1/map')).toBeNull();
    expect(guideHash({ mode: 'mock', tripId: 'a' })).toBe('#/mock/trips/a/guide');
  });
});

describe('geolocation consent and fallback', () => {
  const places = trip.places;
  it('without the consent button the device is never asked', async () => {
    const geo: GeoLike = { getCurrentPosition: vi.fn() };
    const a = await chooseArea({ useDevice: false, geo, day, places });
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(a.source).toBe('trip');
  });
  it('denied and error fall back to the trip places and report why', async () => {
    const mk = (code: number): GeoLike => ({ getCurrentPosition: (_ok, fail) => fail({ code }) });
    expect(await chooseArea({ useDevice: true, geo: mk(1), day, places })).toMatchObject({ source: 'trip', deviceFailure: 'denied' });
    expect(await chooseArea({ useDevice: true, geo: mk(2), day, places })).toMatchObject({ source: 'trip', deviceFailure: 'error' });
    expect(await chooseArea({ useDevice: true, geo: null, day, places })).toMatchObject({ source: 'trip', deviceFailure: 'error' });
  });
  it('granted position becomes a bbox only, and nothing is written to browser storage', async () => {
    const set = vi.fn();
    vi.stubGlobal('localStorage', { setItem: set, getItem: () => null });
    vi.stubGlobal('sessionStorage', { setItem: set, getItem: () => null });
    const geo: GeoLike = { getCurrentPosition: ok => ok({ coords: { latitude: 36.56, longitude: 136.65 } }) };
    const a = await chooseArea({ useDevice: true, geo, day, places });
    expect(a.source).toBe('device');
    if (a.source !== 'device') throw new Error();
    expect(a.bbox.south).toBeLessThan(36.56);
    expect(a.bbox.north).toBeGreaterThan(36.56);
    expect(JSON.stringify(a)).not.toContain('"lat"');
    expect(set).not.toHaveBeenCalled();
  });
  it('no located place and no device -> none', async () => {
    expect(await chooseArea({ useDevice: false, geo: null, day: undefined, places })).toEqual({ source: 'none', deviceFailure: null });
    expect(fallbackBbox(day, places.map(p => ({ ...p, location: null })))).toBeNull();
  });
  it('bbox side stays within the server 5 km limit', () => {
    const b = bboxAround({ lat: 36.56, lng: 136.65 });
    expect((b.north - b.south) * 111).toBeLessThanOrEqual(5);
    expect((b.east - b.west) * 111 * Math.cos((36.56 * Math.PI) / 180)).toBeLessThanOrEqual(5);
    expect(amenitiesUrl(b, ['toilet'])).toMatch(/^\/api\/v1\/amenities\?bbox=[-\d.,]+&kind=toilet$/);
  });
});

describe('empty vs unsupported vs failure are distinct', () => {
  it('classifies server data', () => {
    expect(classifyAmenities(resp({})).state).toBe('empty');
    expect(classifyAmenities(resp({ dataStatus: 'unsupported_region', reason: 'x' })).state).toBe('unsupported');
    expect(classifyAmenities(resp({ dataStatus: 'unavailable', reason: 'x' })).state).toBe('error');
    expect(classifyAmenities(resp({ items: [shelter] })).state).toBe('ok');
  });
  it('fetchAmenities: 503, network failure and schema mismatch are errors, never empty', async () => {
    const b = bboxAround({ lat: 36.56, lng: 136.65 });
    const err503 = { code: 'UNAVAILABLE', message: '未接続', retryable: true, requestId: 'r1' };
    expect(await fetchAmenities(b, { fetch: async () => json(503, err503) })).toMatchObject({ state: 'error', code: 'UNAVAILABLE', requestId: 'r1' });
    expect(await fetchAmenities(b, { fetch: async () => json(422, { code: 'VALIDATION_FAILED', message: '範囲過大', retryable: false, requestId: 'r2' }) })).toMatchObject({ state: 'error', code: 'VALIDATION_FAILED' });
    expect(await fetchAmenities(b, { fetch: async () => { throw new Error('offline'); } })).toEqual({ state: 'error', message: 'offline' });
    expect((await fetchAmenities(b, { fetch: async () => json(200, { items: 'x' }) })).state).toBe('error');
    expect((await fetchAmenities(b, { fetch: async () => json(200, resp({})) })).state).toBe('empty');
  });
  it('renders three different screens', () => {
    const noop = () => {};
    const empty = render(<AmenitiesPanel load={{ state: 'empty', reason: null, dataStatus: 'fixture' }} onRetry={noop} />);
    const unsup = render(<AmenitiesPanel load={{ state: 'unsupported', reason: null, supportedRegion: '金沢' }} onRetry={noop} />);
    const fail = render(<AmenitiesPanel load={{ state: 'error', message: '503' }} onRetry={noop} />);
    expect(empty).toContain(EMPTY_TEXT);
    expect(unsup).toContain(UNSUPPORTED_TEXT);
    expect(unsup).not.toContain(EMPTY_TEXT);
    expect(fail).toContain('role="alert"');
    expect(fail).toContain('再試行');
    expect(fail).not.toContain(EMPTY_TEXT);
  });
});

describe('shelter warning and fixture labelling', () => {
  it('shelter warning is shown under the map even if the provider sent an empty warning', () => {
    const load: AmenitiesLoad = { state: 'ok', items: [shelter], dataStatus: 'fixture', fetchedAt: null };
    expect(render(<GuideView trip={trip} mock geo={null} today={day.date} initialAmenities={load} />)).toContain(SHELTER_WARNING);
  });
  it('fixture amenities carry 【架空】 and sites/shelters are separate kinds', () => {
    const m = mockAmenities(bboxAround({ lat: 36.56, lng: 136.65 }));
    if (m.state !== 'ok') throw new Error();
    expect(m.items.every(i => displayName(i).startsWith('【架空】'))).toBe(true);
    expect(new Set(m.items.map(i => i.kind)).size).toBe(3);
    expect(m.items.every(i => i.openNow === null)).toBe(true);
  });
});

describe('spots', () => {
  it('uses the current day and numbered spots, with 解説なし when no description', () => {
    expect(currentDayIndex(trip, day.date)).toBe(0);
    expect(currentDayIndex(trip, '1999-01-01')).toBe(0);
    const pts = mapPoints(day, trip.places);
    expect(pts.length).toBeGreaterThan(0);
    const bare = spotDetail(pts[0]!, trip.places.map(p => ({ ...p, description: null, photo: null })));
    expect(bare.description).toBe('解説なし');
    expect(render(<SpotPanel detail={bare} />)).toContain('解説なし');
    const withDesc = spotDetail(pts[0]!, trip.places.map(p => ({ ...p, description: '解説本文', photo: { url: 'https://example.com/a.jpg', attribution: '撮影者X', license: 'CC BY' } })));
    const html = render(<SpotPanel detail={withDesc} />);
    expect(html).toContain('解説本文');
    expect(html).toContain('撮影者X');
    expect(html).toContain('出典');
  });
});

describe('guide map (R5: points on the map, no place list)', () => {
  it('renders no numbered place chip list; the points are focusable buttons on the sketch map', () => {
    const html = render(<GuideView trip={trip} mock geo={null} today={day.date} />);
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('it-item');
    expect(html).toContain('data-testid="map-fallback"');
    expect(html).toContain('role="button" tabindex="0"');
  });
});

describe('K19 guides (description + licensed photo)', () => {
  const pt = mapPoints(day, trip.places)[0]!;
  const base = (over: object = {}) => spotDetail(pt, trip.places.map(p => ({ ...p, description: null, photo: null, ...over })));
  const gprov = { ...prov, source: 'wikipedia', attribution: 'Wikipedia「兼六園」(ja.wikipedia.org), CC BY-SA 4.0（抜粋・HTML除去）' };
  const gitem = (over: object = {}): GuideItem => ({
    number: 1, placeId: pt.placeId, name: pt.name, kind: 'spot', location: null, description: 'Wikipedia本文',
    photo: { url: 'https://upload.wikimedia.org/a.jpg', attribution: '撮影者Y', license: 'CC BY-SA 4.0' }, provenance: gprov, ...over,
  });
  const okLoad = (over: object = {}): GuideLoad => ({ state: 'ok', item: gitem(over), dataStatus: 'verified' });

  it('shows guide text, photo with author, licence and source link', () => {
    const html = render(<SpotPanel detail={base({ description: 'trip本文' })} guide={okLoad()} />);
    expect(html).toContain('Wikipedia本文');
    expect(html).not.toContain('trip本文');
    expect(html).toContain('撮影者Y');
    expect(html).toContain('CC BY-SA 4.0');
    expect(html).toContain('href="https://upload.wikimedia.org/a.jpg"');
    expect(html).toContain('ja.wikipedia.org');
  });
  it('never renders a photo lacking licence or author', () => {
    for (const photo of [{ url: 'https://upload.wikimedia.org/a.jpg', attribution: '撮影者', license: null }, { url: 'https://upload.wikimedia.org/a.jpg', attribution: '  ', license: 'CC BY' }, { url: 'http://upload.wikimedia.org/a.jpg', attribution: 'x', license: 'CC BY' }]) {
      expect(render(<SpotPanel detail={base()} guide={okLoad({ photo })} />)).not.toContain('<img');
    }
    // a photo-less guide item does not fall back to a trip photo that is itself unlicensed
    expect(render(<SpotPanel detail={base({ photo: { url: 'https://example.com/x.jpg', attribution: 'a', license: null } })} guide={okLoad({ photo: null })} />)).not.toContain('<img');
  });
  it('falls back to Trip.places on empty/error/loading, and to 解説なし when neither', () => {
    for (const g of [null, { state: 'empty', reason: null } as GuideLoad, { state: 'error', message: 'x' } as GuideLoad]) {
      expect(render(<SpotPanel detail={base({ description: 'trip本文' })} guide={g} />)).toContain('trip本文');
      expect(render(<SpotPanel detail={base()} guide={g} />)).toContain('解説なし');
    }
    expect(mergeGuide(spotDetail(pt, trip.places), { state: 'error', message: 'x' }).textFrom).not.toBe('guide');
  });
  it('fetchGuide: ok / empty / 503 / invalid body / network error, and no-store request', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (res: Response | Error) => async (url: string, init?: RequestInit) => { calls.push({ url, ...(init ? { init } : {}) }); if (res instanceof Error) throw res; return res; };
    const resp = (items: GuideItem[], dataStatus = 'verified', reason: string | null = null) => json(200, { items, dataStatus, reason, fetchedAt: '2026-10-24T00:00:00Z' });
    expect((await fetchGuide(pt.placeId, { fetch: f(resp([gitem()])) })).state).toBe('ok');
    expect(calls[0]!.url).toBe(guidesUrl(pt.placeId));
    expect(calls[0]!.init?.cache).toBe('no-store');
    expect(await fetchGuide(pt.placeId, { fetch: f(resp([], 'unknown', '該当なし')) })).toEqual({ state: 'empty', reason: '該当なし' });
    expect(await fetchGuide(pt.placeId, { fetch: f(resp([], 'unavailable', '失敗')) })).toEqual({ state: 'error', message: '失敗' });
    expect((await fetchGuide(pt.placeId, { fetch: f(json(503, { code: 'UNAVAILABLE', message: '混雑', retryable: true, requestId: 'r' })) })).state).toBe('error');
    expect((await fetchGuide(pt.placeId, { fetch: f(json(200, { items: 'x' })) })).state).toBe('error');
    expect((await fetchGuide(pt.placeId, { fetch: f(new Error('net')) })).state).toBe('error');
  });
  it('guidesUrl encodes the placeId', () => {
    expect(guidesUrl('a b&c')).toBe('/api/v1/guides?placeId=a%20b%26c&lang=ja');
  });
});

describe('U07 review (M2): map markers, no explanatory texts, itinerary under the map', () => {
  const m = mockAmenities(bboxAround({ lat: 36.56, lng: 136.65 }));
  if (m.state !== 'ok') throw new Error();
  const view = (over: Partial<Parameters<typeof GuideView>[0]> = {}) => render(<GuideView trip={trip} mock geo={null} today={day.date} initialAmenities={m} {...over} />);

  it('passes one marker per enabled layer item, with a distinct shape per kind', () => {
    const all = amenityMarkers(m.items, ALL);
    expect(all).toHaveLength(m.items.length);
    expect(new Set(all.map(x => x.shape)).size).toBe(3);
    expect(new Set(all.map(x => x.glyph)).size).toBe(3);
    expect(all.every(x => x.title.includes('【架空】'))).toBe(true);
    for (const k of ['toilet', 'evacuation_site', 'evacuation_shelter'] as const) {
      const only = amenityMarkers(m.items, new Set<AmenityKind>([k]));
      expect(only).toHaveLength(m.items.filter(i => i.kind === k).length);
      expect(only.length).toBeGreaterThan(0);
    }
    expect(amenityMarkers(m.items, new Set())).toEqual([]);
  });
  it('draws them on the sketch map with the shelter and 【架空】 warnings', () => {
    const html = view();
    expect((html.match(/data-testid="extra-marker"/g) ?? []).length).toBe(m.items.length);
    expect(html).toContain(SHELTER_WARNING);
    expect(html).toContain('【架空】');
    expect(view({ initialAmenities: { ...m, items: m.items.filter(i => i.kind === 'toilet') } })).not.toContain('指定は「現在開設中」を意味しません');
  });
  it('does not show the two explanatory texts', () => {
    const html = view();
    expect(html).not.toContain('地点を選ぶと解説を表示します');
    expect(html).not.toContain('ブラウザが位置情報の許可を求めます');
    expect(html).toContain('aria-label="現在地を使う');
  });
  it('shows found items on the map only, with the kind checkboxes as the map legend (comment 6392977146)', () => {
    const html = view();
    expect(html).not.toContain('aria-label="トイレ・避難場所"');
    expect(html).not.toContain('近くのトイレ・避難場所</h2>');
    expect(html).not.toContain('表示する種類');
    const legendAt = html.indexOf('aria-label="地図の記号（チェックで表示）"');
    expect(legendAt).toBeGreaterThan(html.indexOf('data-testid="map-fallback"'));
    expect(legendAt).toBeLessThan(html.indexOf('<table'));
    const legend = html.slice(legendAt, html.indexOf('</fieldset>', legendAt));
    expect(legend.match(/type="checkbox"/g)).toHaveLength(3);
    for (const k of ['toilet', 'evacuation_site', 'evacuation_shelter'] as const) expect(legend).toContain(AMENITY_KIND_LABEL[k]);
    expect(render(<AmenitiesPanel load={m} onRetry={() => {}} />)).toBe('');
  });
  it('places 現在地を使う right under the map: map, button, itinerary (comment 6392903175)', () => {
    const html = view();
    const mapAt = html.indexOf('data-testid="map-fallback"');
    const buttonAt = html.indexOf('aria-label="現在地を使う');
    expect(mapAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(mapAt);
    expect(html.indexOf('<table')).toBeGreaterThan(-1);
    expect(buttonAt).toBeLessThan(html.indexOf('<table'));
    expect(html.match(/aria-label="現在地を使う/g)).toHaveLength(1);
  });
  it('renders the numbered itinerary table right under the map, numbers matching the map', () => {
    const html = view();
    const mapAt = html.indexOf('data-testid="map-fallback"');
    const tableAt = html.indexOf('<table');
    expect(mapAt).toBeGreaterThan(-1);
    expect(tableAt).toBeGreaterThan(mapAt);
    expect(html).not.toContain('it-drag');
    for (const p of mapPoints(day, trip.places)) {
      expect(html).toContain(`aria-label="${p.number}. ${p.name}"`);
      expect(html).toContain(`aria-label="地図の地点${p.number}"`);
    }
  });
  it('selection sync: a selected place highlights its table row and shows its guide detail', () => {
    const p = mapPoints(day, trip.places)[1]!;
    const html = view({ initialSelected: p.placeId });
    expect(html).toContain(`aria-label="${p.number}. ${p.name}（選択中）"`);
    expect(html).toContain(`aria-label="地点${p.number}の解説"`);
    expect(html).toMatch(/<tr[^>]*class="it-stay it-on/);
  });
});
