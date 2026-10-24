import { PlaceInfo } from '@tkb/contracts';
import { parseOpeningHours } from '@tkb/planner';
import { kanazawaPlaces } from '@tkb/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { CallBudget, DailyQuota, Gate } from '../policy/budget.ts';
import { SAFE_DEFAULT_LIMITS, SKU } from '../policy/limits.ts';
import { FixturePlacesProvider } from './fixture.ts';
import { GooglePlacesProvider, kindFromTypes } from './google.ts';
import { openingHoursText } from './hours.ts';

const NOW = Date.parse('2026-10-24T10:00:00Z');
const budget = (over: Partial<ConstructorParameters<typeof CallBudget>[0]> = {}) =>
  new CallBudget({ maxCalls: 8, quota: new DailyQuota(SAFE_DEFAULT_LIMITS.dailyPerSku, () => NOW), gate: new Gate(2), retryDelayMs: () => 0, ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function provider(respond: (init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => respond(init!));
  return { p: new GooglePlacesProvider({ apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch, now: () => NOW }), fetchMock };
}
const KANAZAWA = { south: 36.55, west: 136.64, north: 36.59, east: 136.68 };

const day = (d: number, oh: number, om: number, ch: number, cm: number, cd = d) => ({ open: { day: d, hour: oh, minute: om }, close: { day: cd, hour: ch, minute: cm } });
const everyDay = (oh: number, om: number, ch: number, cm: number) => [0, 1, 2, 3, 4, 5, 6].map(d => day(d, oh, om, ch, cm));

// Shapes per the Places API (New) Place reference (id, displayName.text, location, types, primaryType, regularOpeningHours, attributions).
const kenrokuen = {
  id: 'ChIJ_kenrokuen-test_1',
  displayName: { text: '兼六園', languageCode: 'ja' },
  formattedAddress: '石川県金沢市兼六町1',
  location: { latitude: 36.5625, longitude: 136.6625 },
  types: ['tourist_attraction', 'park', 'point_of_interest'],
  primaryType: 'tourist_attraction',
  regularOpeningHours: { periods: everyDay(7, 0, 18, 0), weekdayDescriptions: ['月曜日: 7時00分～18時00分'] },
};
const louvre = {
  id: 'ChIJ_louvre-test_2',
  displayName: { text: 'Musée du Louvre' },
  location: { latitude: 48.8606, longitude: 2.3376 },
  primaryType: 'museum',
  regularOpeningHours: {
    // Closed on Tuesday (day 2): not the same every day.
    periods: [0, 1, 3, 4, 5, 6].map(d => day(d, 9, 0, 18, 0)),
    weekdayDescriptions: ['Monday: 9:00 AM – 6:00 PM', 'Tuesday: Closed'],
  },
  attributions: [{ provider: 'Some Data Partner', providerUri: 'https://example.org' }],
};

describe('openingHoursText', () => {
  it('writes same-every-day hours in the form D06 reads, including split days, overnight and 24 hours', () => {
    expect(openingHoursText({ periods: everyDay(9, 0, 17, 30) })).toBe('9:00-17:30');
    expect(openingHoursText({ periods: [0, 1, 2, 3, 4, 5, 6].flatMap(d => [day(d, 11, 30, 14, 0), day(d, 17, 0, 22, 0)]) })).toBe('11:30-14:00, 17:00-22:00');
    expect(openingHoursText({ periods: [0, 1, 2, 3, 4, 5, 6].map(d => day(d, 18, 0, 2, 0, (d + 1) % 7)) })).toBe('18:00-2:00');
    expect(openingHoursText({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })).toBe('24時間');
  });

  it('produces text that the D06 parser reads, and turns 0:00 to the next 0:00 into 24時間', () => {
    const outputs = [
      openingHoursText({ periods: everyDay(9, 0, 17, 30) }),
      openingHoursText({ periods: [0, 1, 2, 3, 4, 5, 6].map(d => day(d, 18, 0, 2, 0, (d + 1) % 7)) }),
      openingHoursText({ periods: [0, 1, 2, 3, 4, 5, 6].flatMap(d => [day(d, 17, 0, 22, 0), day(d, 11, 30, 14, 0)]) }), // out of order
      openingHoursText({ periods: [0, 1, 2, 3, 4, 5, 6].map(d => day(d, 0, 0, 0, 0, (d + 1) % 7)) }),
    ];
    expect(outputs).toEqual(['9:00-17:30', '18:00-2:00', '11:30-14:00, 17:00-22:00', '24時間']);
    for (const text of outputs) expect(parseOpeningHours(text), text!).not.toBeNull();
  });

  it('does not read a period closing two days later as a daily pattern', () => {
    expect(openingHoursText({ periods: [0, 1, 2, 3, 4, 5, 6].map(d => day(d, 9, 0, 17, 0, (d + 2) % 7)), weekdayDescriptions: ['x'] })).toBe('x');
  });

  it("keeps the provider's descriptions when days differ or a day is closed, and null when nothing is usable", () => {
    expect(openingHoursText(louvre.regularOpeningHours)).toBe('Monday: 9:00 AM – 6:00 PM / Tuesday: Closed');
    const differing = [...everyDay(9, 0, 17, 0).slice(0, 6), day(6, 10, 0, 16, 0)];
    expect(openingHoursText({ periods: differing, weekdayDescriptions: ['土曜日: 10時00分～16時00分'] })).toBe('土曜日: 10時00分～16時00分');
    expect(openingHoursText({ periods: [day(1, 9, 0, 17, 0)] })).toBeNull(); // one day only, no descriptions: unknown
    expect(openingHoursText(undefined)).toBeNull();
    expect(openingHoursText({})).toBeNull();
  });
});

describe('GooglePlacesProvider', () => {
  it('maps domestic and overseas places to valid PlaceInfo with provenance and attribution (国内外・帰属表示)', async () => {
    const { p, fetchMock } = provider(() => json({ places: [kenrokuen, louvre] }));
    const r = await p.searchText({ query: '観光', timeZone: 'Asia/Tokyo', maxResults: 5, withHours: true }, budget());
    expect(r.reason).toBeNull();
    for (const place of r.places) expect(PlaceInfo.safeParse(place).success).toBe(true);
    expect(r.places[0]).toMatchObject({
      placeId: 'ChIJ_kenrokuen-test_1',
      name: '兼六園',
      kind: 'spot',
      location: { lat: 36.5625, lng: 136.6625 },
      timeZone: 'Asia/Tokyo',
      openingHours: '7:00-18:00',
      description: null,
      photo: null,
      dataStatus: 'verified',
      provenance: { source: 'google_places', attribution: 'Google Maps', mayStore: false, maySendToModel: false, mayExport: false },
    });
    // Third-party data must be credited beyond "Google Maps", once each.
    expect(r.places[1]!.provenance.attribution).toBe('Google Maps / Some Data Partner');
    const twice = await provider(() => json({ places: [{ ...louvre, attributions: [...louvre.attributions, ...louvre.attributions] }] })).p.searchText({ query: 'x', timeZone: 'Europe/Paris', maxResults: 1 }, budget());
    expect(twice.places[0]!.provenance.attribution).toBe('Google Maps / Some Data Partner');
    expect(r.places[1]!.openingHours).toContain('Tuesday: Closed');

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-Goog-FieldMask']).toContain('places.regularOpeningHours');
  });

  it('leaves opening hours null when not asked for (Pro SKU) or not returned (営業時間欠落)', async () => {
    const q = new DailyQuota(SAFE_DEFAULT_LIMITS.dailyPerSku, () => NOW);
    const pro = provider(() => json({ places: [kenrokuen] }));
    const r = await pro.p.searchText({ query: '兼六園', timeZone: 'Asia/Tokyo', maxResults: 1 }, budget({ quota: q }));
    expect(r.places[0]!.openingHours).toBeNull();
    expect((pro.fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['X-Goog-FieldMask']).not.toContain('regularOpeningHours');
    expect(q.remaining(SKU.placesTextSearchPro)).toBe(19);
    expect(q.remaining(SKU.placesTextSearchEnterprise)).toBe(20);

    const { regularOpeningHours: _drop, ...noHours } = kenrokuen;
    void _drop;
    const r2 = await provider(() => json({ places: [noHours] })).p.searchText({ query: '兼六園', timeZone: 'Asia/Tokyo', maxResults: 1, withHours: true }, budget({ quota: q }));
    expect(r2.places[0]!.openingHours).toBeNull();
    expect(q.remaining(SKU.placesTextSearchEnterprise)).toBe(19);
  });

  it('sends the rectangle as a location restriction after the D02 area check, and rejects bad input without a call', async () => {
    const { p, fetchMock } = provider(() => json({ places: [kenrokuen] }));
    await p.searchText({ query: '庭園', timeZone: 'Asia/Tokyo', area: KANAZAWA, maxResults: 3 }, budget());
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      textQuery: '庭園',
      pageSize: 3,
      locationRestriction: { rectangle: { low: { latitude: 36.55, longitude: 136.64 }, high: { latitude: 36.59, longitude: 136.68 } } },
    });
    const b = budget();
    for (const bad of [
      { query: '', timeZone: 'Asia/Tokyo', maxResults: 3 },
      { query: '庭園', timeZone: 'Asia/Tokyo', maxResults: 21 },
      { query: '庭園', timeZone: 'Asia/Tokyo', maxResults: 3, area: { south: 35, west: 135, north: 36, east: 136 } },
    ]) {
      await expect(p.searchText(bad, b)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.callsUsed).toBe(0);
  });

  it('finds nearby alternatives by distance, without the place itself (R10)', async () => {
    const around = { ...kanazawaPlaces[1]!, placeId: kenrokuen.id };
    const { p, fetchMock } = provider(() => json({ places: [kenrokuen, { ...kenrokuen, id: 'ChIJ_other', displayName: { text: '近くの庭園' } }] }));
    const r = await p.searchNearby({ around, radiusMeters: 1500, includedTypes: ['park'], maxResults: 5 }, budget());
    expect(r.places.map(x => x.placeId)).toEqual(['ChIJ_other']);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      locationRestriction: { circle: { center: { latitude: 36.562, longitude: 136.662 }, radius: 1500 } },
      includedTypes: ['park'],
      rankPreference: 'DISTANCE',
      maxResultCount: 5,
    });
    await expect(p.searchNearby({ around, radiusMeters: 20_000, maxResults: 5 }, budget())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(p.searchNearby({ around, radiusMeters: 500, includedTypes: ['Restaurant!'], maxResults: 5 }, budget())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // With hours: Nearby Enterprise SKU and the hours field.
    const q = new DailyQuota(SAFE_DEFAULT_LIMITS.dailyPerSku, () => NOW);
    const ent = provider(() => json({ places: [] }));
    await ent.p.searchNearby({ around, radiusMeters: 500, maxResults: 5, withHours: true }, budget({ quota: q }));
    expect((ent.fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['X-Goog-FieldMask']).toContain('places.regularOpeningHours');
    expect(q.remaining(SKU.placesNearbyEnterprise)).toBe(19);
    expect(q.remaining(SKU.placesNearbyPro)).toBe(20);
    expect(await p.searchNearby({ around: { ...around, location: null }, radiusMeters: 500, maxResults: 5 }, budget())).toEqual({ places: [], reason: 'missing_location', dropped: 0 });
  });

  it('tells an empty result from a failure, drops invalid places, and never retries 429', async () => {
    expect(await provider(() => json({})).p.searchText({ query: 'x', timeZone: 'Asia/Tokyo', maxResults: 1 }, budget())).toEqual({ places: [], reason: 'no_results', dropped: 0 });
    const odd = await provider(() => json({ places: [{ id: 'bad id!', displayName: { text: 'x' } }, { id: 'ok_1' }, { id: 'ok_2', displayName: { text: 'No location' } }] })).p.searchText(
      { query: 'x', timeZone: 'Asia/Tokyo', maxResults: 3 },
      budget(),
    );
    expect(odd).toMatchObject({ dropped: 2, reason: null });
    expect(odd.places).toEqual([expect.objectContaining({ placeId: 'ok_2', location: null })]);

    const limited = provider(() => json({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429));
    expect((await limited.p.searchText({ query: 'x', timeZone: 'Asia/Tokyo', maxResults: 1 }, budget())).reason).toBe('rate_limited');
    expect(limited.fetchMock).toHaveBeenCalledTimes(1);
    for (const body of ['<html/>', '[]']) {
      const r = await provider(() => new Response(body, { status: 200 })).p.searchText({ query: 'x', timeZone: 'Asia/Tokyo', maxResults: 1 }, budget());
      expect(r.reason).toBe('provider_unavailable');
    }
    const echoed = await provider(() => json({ error: { message: 'bad key test-key' } }, 403)).p.searchText({ query: 'x', timeZone: 'Asia/Tokyo', maxResults: 1 }, budget());
    expect(JSON.stringify(echoed)).not.toContain('test-key');
  });

  it('maps provider types to our place kinds', () => {
    expect(kindFromTypes('restaurant')).toBe('restaurant');
    expect(kindFromTypes(undefined, ['point_of_interest', 'cafe'])).toBe('restaurant');
    expect(kindFromTypes('train_station')).toBe('station');
    expect(kindFromTypes('market')).toBe('area');
    expect(kindFromTypes('dentist')).toBe('other');
  });
});

describe('FixturePlacesProvider', () => {
  it('searches B04 places by name and distance, labelled fixture, without charging the budget', async () => {
    const b = budget();
    const p = new FixturePlacesProvider();
    const text = await p.searchText({ query: '兼六', timeZone: 'Asia/Tokyo', maxResults: 5 }, b);
    expect(text.places.map(x => [x.placeId, x.dataStatus])).toEqual([['fx_kenrokuen', 'fixture']]);
    const near = await p.searchNearby({ around: kanazawaPlaces[1]!, radiusMeters: 600, maxResults: 5 }, b);
    expect(near.places.map(x => x.placeId)).toEqual(['fx_21c_museum']);
    expect((await p.searchText({ query: 'zzz', timeZone: 'Asia/Tokyo', maxResults: 5 }, b)).reason).toBe('no_results');
    expect(b.callsUsed).toBe(0);
  });

  it('honours the area and the requested types, and refuses the same input as the Google provider', async () => {
    const b = budget();
    const p = new FixturePlacesProvider();
    // 'e' matches Paris places too, but only Kanazawa ones are inside the rectangle.
    const inKanazawa = await p.searchText({ query: 'e', timeZone: 'Asia/Tokyo', area: KANAZAWA, maxResults: 10 }, b);
    expect(inKanazawa.places.every(x => x.timeZone === 'Asia/Tokyo')).toBe(true);
    const food = await p.searchNearby({ around: kanazawaPlaces[0]!, radiusMeters: 5000, includedTypes: ['restaurant'], maxResults: 10 }, b);
    expect(food.places.map(x => x.kind)).toEqual(['restaurant']);
    await expect(p.searchText({ query: 'x'.repeat(201), timeZone: 'Asia/Tokyo', maxResults: 5 }, b)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(p.searchText({ query: '兼六', timeZone: 'Asia/Tokyo', maxResults: 99 }, b)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
