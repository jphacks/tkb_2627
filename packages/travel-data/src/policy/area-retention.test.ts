import type { PermittedFact, PlaceInfo } from '@tkb/contracts';
import { kanazawaPlaces } from '@tkb/fixtures';
import { describe, expect, it } from 'vitest';
import { checkArea } from './area.ts';
import { PolicyError } from './budget.ts';
import { classifyField, DEFAULT_SOURCE_POLICIES, factsForModel, isExpired, provenanceFor, purgeExpired } from './retention.ts';

const KANAZAWA = { south: 36.55, west: 136.64, north: 36.59, east: 136.68 }; // about 3.6 km x 4.4 km

describe('checkArea (矩形の要素数)', () => {
  it('accepts a city-sized rectangle and counts billed pages', () => {
    const r = checkArea(KANAZAWA, 30);
    expect(r.widthKm).toBeGreaterThan(3);
    expect(r.widthKm).toBeLessThan(4);
    expect(r.heightKm).toBeGreaterThan(4);
    expect(r.heightKm).toBeLessThan(5);
    expect(r.pages).toBe(2); // 30 places at 20 per page
    expect(checkArea(KANAZAWA, 1).pages).toBe(1);
  });

  it('rejects too many items, too large or malformed rectangles before any call', () => {
    const code = (f: () => unknown) => {
      try {
        f();
        return 'ok';
      } catch (e) {
        return e instanceof PolicyError ? e.code : 'other';
      }
    };
    expect(code(() => checkArea(KANAZAWA, 31))).toBe('VALIDATION_FAILED');
    expect(code(() => checkArea(KANAZAWA, 0))).toBe('VALIDATION_FAILED');
    expect(code(() => checkArea(KANAZAWA, 2.5))).toBe('VALIDATION_FAILED');
    expect(code(() => checkArea({ south: 35, west: 135, north: 36, east: 136 }, 5))).toBe('VALIDATION_FAILED'); // ~110 km
    expect(code(() => checkArea({ ...KANAZAWA, north: 36.5 }, 5))).toBe('VALIDATION_FAILED'); // south >= north
    expect(code(() => checkArea({ south: 0, west: 179.9, north: 0.1, east: -179.9 }, 5))).toBe('VALIDATION_FAILED'); // antimeridian
    expect(code(() => checkArea({ ...KANAZAWA, east: Number.NaN }, 5))).toBe('VALIDATION_FAILED');
    expect(code(() => checkArea({ ...KANAZAWA, north: 91 }, 5))).toBe('VALIDATION_FAILED');
  });

  it('measures the width where the rectangle is widest (nearest the equator), in both hemispheres', () => {
    // 0.27 degrees of longitude is ~30 km at the equator but ~19 km at 50 degrees.
    expect(() => checkArea({ south: 50, west: 0, north: 50.1, east: 0.27 }, 1)).not.toThrow();
    expect(() => checkArea({ south: -0.05, west: 0, north: 0.05, east: 0.28 }, 1)).toThrow(PolicyError);
    // With a 3000 km limit, 35.5 degrees is ~3027 km at 40 degrees but ~1976 km at 60: the edge nearer the equator counts.
    const wide = { maxSideKm: 3000, maxItems: 30, pageSize: 20 };
    expect(() => checkArea({ south: 40, west: 0, north: 60, east: 35.5 }, 1, wide)).toThrow(PolicyError);
    expect(() => checkArea({ south: -60, west: 0, north: -40, east: 35.5 }, 1, wide)).toThrow(PolicyError);
    expect(() => checkArea({ south: -60, west: 0, north: -40, east: 34 }, 1, wide)).not.toThrow();
  });

  it('rejects rectangles spanning most of the globe in longitude (not the short way round)', () => {
    expect(() => checkArea({ south: 0, west: -180, north: 0.1, east: 180 }, 5)).toThrow(PolicyError);
    expect(() => checkArea({ south: 36.5, west: -179.9, north: 36.6, east: 179.9 }, 5)).toThrow(PolicyError);
  });

  it('refuses invalid limits instead of computing nonsense', () => {
    expect(() => checkArea(KANAZAWA, 1, { maxSideKm: 30, maxItems: 30, pageSize: 0 })).toThrow(RangeError);
    expect(() => checkArea(KANAZAWA, 1, { maxSideKm: Number.NaN, maxItems: 30, pageSize: 20 })).toThrow(RangeError);
  });
});

describe('data policy (保存可能な内容の分類・期限切れ)', () => {
  const fetched = Date.parse('2026-10-24T08:00:00Z');

  it("follows M1's defaults for Google: only the provider place ID may be stored, nothing to the model or exports", () => {
    // The contract field PlaceInfo.placeId carries Google's place ID (D03), the one exempt from caching limits.
    expect(classifyField('google_places', 'placeId')).toBe('store');
    for (const f of ['constructor', 'toString', '__proto__']) expect(classifyField('google_places', f)).toBe('display_only');
    expect(() => classifyField('toString', 'x')).toThrow(RangeError);
    for (const f of ['name', 'location', 'openingHours', 'photo']) expect(classifyField('google_places', f)).toBe('display_only');
    expect(classifyField('google_routes', 'durationSeconds')).toBe('display_only');
    expect(classifyField('fixture', 'name')).toBe('store');
    expect(() => classifyField('unknown_provider', 'name')).toThrow(RangeError);

    expect(provenanceFor('google_places', fetched)).toEqual({
      source: 'google_places',
      fetchedAt: '2026-10-24T08:00:00Z',
      attribution: 'Google Maps',
      maySendToModel: false,
      mayStore: false,
      mayExport: false,
      retainUntil: '2026-10-24T08:00:00Z',
    });
    expect(provenanceFor('fixture', fetched)).toMatchObject({ mayStore: true, retainUntil: null });
  });

  it('expires display-only data after its display time and keeps storable or own data', () => {
    const policies = { ...DEFAULT_SOURCE_POLICIES, google_places: { ...DEFAULT_SOURCE_POLICIES.google_places!, displayTtlSeconds: 3600 } };
    const g = provenanceFor('google_places', fetched, policies);
    expect(g.retainUntil).toBe('2026-10-24T09:00:00Z');
    expect(isExpired(g, Date.parse('2026-10-24T08:59:59Z'))).toBe(false);
    expect(isExpired(g, Date.parse('2026-10-24T09:00:01Z'))).toBe(true);
    expect(isExpired(null, Date.now())).toBe(false);
    expect(isExpired({ ...g, retainUntil: 'not-a-date' }, fetched)).toBe(true); // unreadable counts as expired

    const items = [
      { id: 'google', provenance: g },
      { id: 'fixture', provenance: provenanceFor('fixture', fetched) },
      { id: 'own', provenance: null },
    ];
    const { kept, expired } = purgeExpired(items, Date.parse('2026-10-25T00:00:00Z'));
    expect(kept.map(i => i.id)).toEqual(['fixture', 'own']);
    expect(expired.map(i => i.id)).toEqual(['google']);
  });

  it('keeps provider data the model may not see out of the model input', () => {
    const google: PlaceInfo = { ...kanazawaPlaces[1]!, placeId: 'g1', provenance: provenanceFor('google_places', fetched) };
    const facts: PermittedFact[] = [
      { kind: 'place', place: kanazawaPlaces[1]! },
      { kind: 'place', place: google },
    ];
    expect(factsForModel(facts).map(f => (f.kind === 'place' ? f.place.placeId : ''))).toEqual(['fx_kenrokuen']);
  });
});
