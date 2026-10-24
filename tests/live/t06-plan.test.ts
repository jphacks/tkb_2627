import { describe, expect, it, vi } from 'vitest';
import { CallCap, HARD_CAP, buildCases, expectedCalls, googleHostOf, summarizeLeg, summarizePlaces, tomorrow10Utc } from './t06-lib.ts';

describe('T06 plan (no network)', () => {
  it('builds the 4 distinct cases', () => {
    const cases = buildCases();
    expect(cases.map(c => c.id).sort()).toEqual(['domestic-car', 'domestic-transit', 'overseas-car', 'overseas-transit']);
    expect(cases.find(c => c.id === 'overseas-transit')).toMatchObject({ area: 'パリ', timeZone: 'Europe/Paris' });
    expect(cases.find(c => c.id === 'domestic-car')).toMatchObject({ area: '金沢', timeZone: 'Asia/Tokyo' });
  });
  it('plans within the cap and refuses beyond it, without calling fetch', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(expectedCalls(buildCases())).toEqual({ places: 4, routes: 4, total: 8 });
    expect(expectedCalls(buildCases()).total).toBeLessThanOrEqual(HARD_CAP);
    const cap = new CallCap(6);
    for (let i = 0; i < 6; i++) cap.record(i % 2 ? 'routes.googleapis.com' : 'places.googleapis.com');
    expect(() => cap.record('places.googleapis.com')).toThrow(/cap/);
    expect(cap.total).toBe(6);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('classifies hosts', () => {
    expect(googleHostOf('https://places.googleapis.com/v1/places:searchText')).toBe('places.googleapis.com');
    expect(googleHostOf(new URL('https://routes.googleapis.com/x'))).toBe('routes.googleapis.com');
    expect(googleHostOf('http://localhost/api')).toBeNull();
  });
  it('departure is 10:00 local as UTC Z', () => {
    const now = new Date('2026-10-25T05:00:00Z');
    expect(tomorrow10Utc('Asia/Tokyo', now)).toBe('2026-10-26T01:00:00Z');
    expect(tomorrow10Utc('Europe/Paris', now)).toBe('2026-10-26T09:00:00Z'); // CET after DST ends on 25 Oct
  });
  it('summaries carry no names or coordinates', () => {
    const s = JSON.stringify([summarizePlaces([{ name: 'SECRET', location: { lat: 1, lng: 2 }, openingHours: null, photo: null, description: 'x', dataStatus: 'verified', provenance: { source: 'google_places' } }]), summarizeLeg({ mode: 'car', dataStatus: 'verified', durationSeconds: 5, fare: null, lineName: null, platform: null, transfers: null, transit: null, provenance: { source: 'google_routes' } })]);
    expect(s).not.toMatch(/SECRET|"lat"/);
    expect(s).toContain('"durationKnown":true');
  });
});
