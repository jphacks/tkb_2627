import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { domesticTrip } from '@tkb/fixtures';
import type { GeoLike } from '../travel/geo.ts';
import { mapPoints } from '../itinerary/model.ts';
import { AmenitiesPanel, SpotPanel } from './GuideScreen.tsx';
import {
  EMPTY_TEXT, SHELTER_WARNING, UNSUPPORTED_TEXT, amenitiesUrl, bboxAround, chooseArea, classifyAmenities, currentDayIndex,
  displayName, fallbackBbox, type AmenityKind, fetchAmenities, mockAmenities, spotDetail, type AmenitiesLoad, type AmenityResponse,
} from './model.ts';
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
    const empty = render(<AmenitiesPanel load={{ state: 'empty', reason: null, dataStatus: 'fixture' }} enabled={ALL} onRetry={noop} />);
    const unsup = render(<AmenitiesPanel load={{ state: 'unsupported', reason: null, supportedRegion: '金沢' }} enabled={ALL} onRetry={noop} />);
    const fail = render(<AmenitiesPanel load={{ state: 'error', message: '503' }} enabled={ALL} onRetry={noop} />);
    expect(empty).toContain(EMPTY_TEXT);
    expect(unsup).toContain(UNSUPPORTED_TEXT);
    expect(unsup).not.toContain(EMPTY_TEXT);
    expect(fail).toContain('role="alert"');
    expect(fail).toContain('再試行');
    expect(fail).not.toContain(EMPTY_TEXT);
  });
});

describe('shelter warning and fixture labelling', () => {
  it('shelter warning is always shown even if the provider sent an empty warning', () => {
    const load: AmenitiesLoad = { state: 'ok', items: [shelter], dataStatus: 'fixture', fetchedAt: null };
    const html = render(<AmenitiesPanel load={load} enabled={ALL} onRetry={() => {}} />);
    expect(html).toContain(SHELTER_WARNING);
    expect(html).toContain('指定避難所');
    // hiding the layer does not drop the list-level notice
    expect(render(<AmenitiesPanel load={load} enabled={new Set<AmenityKind>(['toilet'])} onRetry={() => {}} />)).toContain(SHELTER_WARNING);
  });
  it('fixture amenities carry 【架空】 and sites/shelters are separate kinds', () => {
    const m = mockAmenities(bboxAround({ lat: 36.56, lng: 136.65 }));
    if (m.state !== 'ok') throw new Error();
    expect(m.items.every(i => displayName(i).startsWith('【架空】'))).toBe(true);
    expect(new Set(m.items.map(i => i.kind)).size).toBe(3);
    const html = render(<AmenitiesPanel load={m} enabled={ALL} onRetry={() => {}} />);
    expect(html).toContain('指定緊急避難場所');
    expect(html).toContain('指定避難所');
    expect(html).toContain(SHELTER_WARNING);
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
