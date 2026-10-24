import type { PlaceInfo } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { describe, expect, it } from 'vitest';
import { MAPS_LINK_NOTICE, MAPS_URL_MAX_LENGTH, placeSearchLink, routeLinks, tripMapsLinks, type MapsLink } from './maps-url.ts';

const place = (placeId: string, extra: Partial<PlaceInfo> = {}): PlaceInfo => ({
  placeId,
  name: placeId,
  kind: 'spot',
  location: null,
  timeZone: 'Asia/Tokyo',
  openingHours: null,
  description: null,
  photo: null,
  dataStatus: 'verified',
  provenance: { source: 'test', fetchedAt: null, attribution: null, maySendToModel: false, mayStore: true, mayExport: true, retainUntil: null },
  ...extra,
});

const params = (link: MapsLink) => new URL(link.url).searchParams;
const pointsOf = (link: MapsLink) => {
  const p = params(link);
  return [p.get('origin'), ...(p.get('waypoints')?.split('|') ?? []), p.get('destination')];
};

describe('placeSearchLink', () => {
  it('uses the official search URL with coordinates when known', () => {
    expect(placeSearchLink(place('k', { location: { lat: 36.562, lng: 136.662 } })).url).toBe(
      'https://www.google.com/maps/search/?api=1&query=36.562000%2C136.662000',
    );
    // Fixed decimals: never an exponent.
    expect(placeSearchLink(place('t', { location: { lat: 1e-7, lng: 2 } })).url).toContain('query=0.000000%2C2.000000');
  });

  it('adds the area to a name-only search so a common name does not open elsewhere', () => {
    expect(params(placeSearchLink(place('s', { name: '寿司店A' }), '金沢')).get('query')).toBe('寿司店A 金沢');
    expect(params(placeSearchLink(place('s', { name: '金沢駅' }), '金沢')).get('query')).toBe('金沢駅');
  });

  it('falls back to the name and escapes separators, spaces and Japanese', () => {
    const name = 'Café | Le Marais, 3e & 兼六園?#';
    const link = placeSearchLink(place('n', { name }));
    expect(link.url.split('&query=')[1]).not.toMatch(/[ |,&?#]/);
    expect(link.url).toContain('%7C');
    expect(link.url).toContain('%2C');
    expect(params(link).get('api')).toBe('1');
    expect(params(link).get('query')).toBe(name);
  });
});

describe('routeLinks', () => {
  const stops = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => place(id, { name: `地点${id}` }));

  it('splits into URLs of at most 3 waypoints by default, each starting where the previous ended', () => {
    const { links, tooLong } = routeLinks(stops, 'walking');
    expect(tooLong).toEqual([]);
    expect(links.map(pointsOf)).toEqual([
      ['地点a', '地点b', '地点c', '地点d', '地点e'],
      ['地点e', '地点f'],
    ]);
    expect(links.every(l => l.url.startsWith('https://www.google.com/maps/dir/?api=1&') && params(l).get('travelmode') === 'walking')).toBe(true);
    expect(routeLinks(stops, 'driving', { maxWaypoints: 9 }).links).toHaveLength(1);
  });

  it('keeps a waypoint name containing | as one stop', () => {
    const { links } = routeLinks([place('a'), place('m', { name: 'Café | Le Marais' }), place('b')], 'walking');
    expect(pointsOf(links[0]!)).toEqual(['a', 'Café   Le Marais', 'b']);
  });

  it('falls back to the default for an invalid waypoint count and never exceeds 9', () => {
    const many = Array.from({ length: 20 }, (_, i) => place(`s${i}`));
    expect(routeLinks(many, 'walking', { maxWaypoints: Number.NaN }).links[0]!.placeIds).toHaveLength(5);
    expect(routeLinks(many, 'walking', { maxWaypoints: Number.POSITIVE_INFINITY }).links[0]!.placeIds).toHaveLength(5);
    expect(routeLinks(many, 'walking', { maxWaypoints: 50 }).links[0]!.placeIds).toHaveLength(11);
  });

  it('gives transit one URL per segment, without waypoints', () => {
    const { links } = routeLinks(stops.slice(0, 3), 'transit', { maxWaypoints: 9 });
    expect(links.map(pointsOf)).toEqual([
      ['地点a', '地点b'],
      ['地点b', '地点c'],
    ]);
    expect(links.every(l => !params(l).has('waypoints'))).toBe(true);
  });

  it('splits long URLs to stay within 2,048 characters and still covers every stop in order', () => {
    const long = Array.from({ length: 8 }, (_, i) => place(`p${i}`, { name: `${'長い名前'.repeat(20)}${i}` }));
    const { links, tooLong } = routeLinks(long, 'driving', { maxWaypoints: 9 });
    expect(tooLong).toEqual([]);
    expect(links.length).toBeGreaterThan(1);
    expect(links.every(l => l.url.length <= MAPS_URL_MAX_LENGTH)).toBe(true);
    const covered = links.flatMap((l, i) => (i === 0 ? l.placeIds : l.placeIds.slice(1)));
    expect(covered).toEqual(long.map(p => p.placeId));
    links.slice(1).forEach((l, i) => expect(l.placeIds[0]).toBe(links[i]!.placeIds.at(-1)));
  });

  it('reports a single segment that cannot fit instead of returning a broken URL', () => {
    const huge = place('huge', { name: 'x'.repeat(3000) });
    expect(routeLinks([place('a'), huge, place('b')], 'walking')).toEqual({ links: [], tooLong: [['a', 'huge'], ['huge', 'b']] });
  });
});

describe('tripMapsLinks', () => {
  it('builds per-day links on the B04 fixture, taking each segment mode from its leg', () => {
    const r = tripMapsLinks(domesticTrip);
    expect(r.notice).toBe(MAPS_LINK_NOTICE);
    expect(r.notice).toContain('自動登録は行いません');
    const [day1, day2] = r.days;
    // Top-level stops only: the children of 近江町市場エリア (fx_sushi) are not route stops.
    expect(day1!.places.map(l => l.placeIds[0])).toEqual([
      'fx_kanazawa_station', 'fx_omicho', 'fx_kanazawa_castle', 'fx_kenrokuen', 'fx_21c_museum', 'fx_dinner', 'fx_hotel',
    ]);
    expect(day1!.routes.map(l => [l.travelMode, l.placeIds])).toEqual([
      ['transit', ['fx_kanazawa_station', 'fx_omicho']],
      ['walking', ['fx_omicho', 'fx_kanazawa_castle', 'fx_kenrokuen', 'fx_21c_museum', 'fx_dinner']],
      ['transit', ['fx_dinner', 'fx_hotel']],
    ]);
    expect(day2).toMatchObject({ date: '2026-11-02', tooLong: [] });
    expect(day2!.places.map(l => l.placeIds[0])).toEqual(['fx_higashi', 'fx_kazue', 'fx_oyama', 'fx_nagamachi', 'fx_kanazawa_station']);
    expect(r.withheldPlaceIds).toEqual([]);
    expect(r.unknownPlaceIds).toEqual([]);
  });

  it('reports activities whose place is missing from trip.places instead of dropping them silently', () => {
    const trip = structuredClone(domesticTrip);
    trip.places = trip.places.filter(p => p.placeId !== 'fx_omicho');
    const r = tripMapsLinks(trip);
    expect(r.unknownPlaceIds).toEqual(['fx_omicho']);
    expect(r.withheldPlaceIds).toEqual([]);
  });

  it('does not borrow a leg mode across a withheld place', () => {
    const trip = structuredClone(domesticTrip);
    // Omicho → (castle, withheld) → walk legs omicho→castle and castle→garden. Neither leg joins Omicho and the garden,
    // so that segment must use the trip mode (transit), not the walk.
    trip.places = trip.places.map(p => (p.placeId === 'fx_kanazawa_castle' ? { ...p, provenance: { ...p.provenance, mayExport: false } } : p));
    const day1 = tripMapsLinks(trip).days[0]!;
    expect(day1.routes[1]).toMatchObject({ travelMode: 'transit', placeIds: ['fx_omicho', 'fx_kenrokuen'] });
  });

  it('withholds places whose provider does not allow export', () => {
    const trip = structuredClone(domesticTrip);
    trip.places = trip.places.map(p => (p.placeId === 'fx_21c_museum' ? { ...p, provenance: { ...p.provenance, mayExport: false } } : p));
    const r = tripMapsLinks(trip);
    expect(r.withheldPlaceIds).toEqual(['fx_21c_museum']);
    expect(JSON.stringify(r.days)).not.toContain('fx_21c_museum');
  });
});
