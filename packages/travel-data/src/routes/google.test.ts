import type { PlaceInfo } from '@tkb/contracts';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { CallBudget, DailyQuota, Gate } from '../policy/budget.ts';
import { SKU } from '../policy/limits.ts';
import { FixtureRouteProvider } from './fixture.ts';
import { GoogleRoutesProvider, parseDuration, toMoney } from './google.ts';
import type { RouteRequest } from './types.ts';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const place = (id: string, list: PlaceInfo[]) => list.find(p => p.placeId === id)!;
const louvre = place('fx_louvre', parisPlaces);
const orsay = place('fx_orsay', parisPlaces);
const station = place('fx_kanazawa_station', kanazawaPlaces);
const kenrokuen = place('fx_kenrokuen', kanazawaPlaces);

const quota = () => new DailyQuota({ [SKU.routesTransit]: 20, [SKU.routesDrive]: 20 }, () => NOW);
const budget = (over: Partial<ConstructorParameters<typeof CallBudget>[0]> = {}) =>
  new CallBudget({ maxCalls: 8, quota: quota(), gate: new Gate(2), retryDelayMs: () => 0, ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function provider(respond: (init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => respond(init!));
  return { p: new GoogleRoutesProvider({ apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch, now: () => NOW }), fetchMock };
}

const req = (over: Partial<RouteRequest> = {}): RouteRequest => ({ from: louvre, to: orsay, departureUtc: '2026-10-25T09:00:00Z', mode: 'transit', ...over });

// Shape per the Routes API v2 reference (routes[].legs[].steps[].transitDetails.stopDetails / transitLine, travelAdvisory.transitFare as Money).
const transitRoute = {
  routes: [
    {
      duration: '1260s',
      distanceMeters: 2100,
      legs: [
        {
          steps: [
            { travelMode: 'WALK' },
            {
              travelMode: 'TRANSIT',
              transitDetails: {
                stopDetails: { departureStop: { name: 'Palais Royal' }, departureTime: '2026-10-25T09:04:00Z', arrivalStop: { name: 'Concorde' }, arrivalTime: '2026-10-25T09:09:00Z' },
                transitLine: { name: 'Métro ligne 1', nameShort: '1' },
              },
            },
            {
              travelMode: 'TRANSIT',
              transitDetails: {
                stopDetails: { departureStop: { name: 'Concorde' }, departureTime: '2026-10-25T09:13:30.000Z', arrivalStop: { name: 'Solférino' }, arrivalTime: '2026-10-25T09:16:00Z' },
                transitLine: { name: 'Métro ligne 12', nameShort: '12' },
              },
            },
            { travelMode: 'WALK' },
          ],
        },
      ],
      travelAdvisory: { transitFare: { currencyCode: 'EUR', units: '2', nanos: 150000000 } },
    },
  ],
};

describe('GoogleRoutesProvider', () => {
  it('maps a transit route with a transfer: times, lines, transfers and fare as returned; platform stays null', async () => {
    const { p, fetchMock } = provider(() => json(transitRoute));
    const r = await p.route(req(), budget());
    expect(r.reason).toBeNull();
    expect(r.leg).toMatchObject({
      type: 'leg',
      mode: 'transit',
      fromPlaceId: 'fx_louvre',
      toPlaceId: 'fx_orsay',
      departure: { utc: '2026-10-25T09:04:00Z', timeZone: 'Europe/Paris' },
      arrival: { utc: '2026-10-25T09:16:00Z', timeZone: 'Europe/Paris' },
      durationSeconds: 1260,
      lineName: '1 → 12',
      transfers: 1,
      platform: null,
      fare: { amountMinor: 215, currency: 'EUR' },
      dataStatus: 'verified',
      provenance: { source: 'google_routes', mayStore: false, maySendToModel: false, mayExport: false },
    });
    expect(r.leg!.legId).toMatch(/^leg_transit_[a-z0-9]+$/);

    const init = fetchMock.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-FieldMask']).toBe('routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.transitDetails,routes.travelAdvisory.transitFare');
    expect(JSON.parse(init.body as string)).toMatchObject({ travelMode: 'TRANSIT', departureTime: '2026-10-25T09:00:00Z', origin: { location: { latLng: { latitude: 48.861, longitude: 2.336 } } } });
  });

  it('keeps the fare null when the provider gives none (運賃なし), never 0', async () => {
    const noFare = structuredClone(transitRoute);
    delete (noFare.routes[0] as { travelAdvisory?: unknown }).travelAdvisory;
    const r = await provider(() => json(noFare)).p.route(req(), budget());
    expect(r.leg).toMatchObject({ fare: null, lineName: '1 → 12' });
  });

  it('reports no route after the last service instead of inventing one (最終便)', async () => {
    for (const body of [{}, { routes: [] }]) {
      const r = await provider(() => json(body)).p.route(req({ departureUtc: '2026-10-25T23:50:00Z' }), budget());
      expect(r).toEqual({ leg: null, reason: 'no_route' });
    }
  });

  it('marks Japanese transit without a route as unsupported_region (対応外地域, D01) but driving there as normal', async () => {
    const r = await provider(() => json({})).p.route(req({ from: station, to: kenrokuen }), budget());
    expect(r).toEqual({ leg: null, reason: 'unsupported_region' });

    const drive = await provider(() => json({ routes: [{ duration: '600s', distanceMeters: 2500 }] })).p.route(req({ from: station, to: kenrokuen, mode: 'car' }), budget());
    // Driving is not timed here: no invented departure/arrival, only the returned duration.
    expect(drive.leg).toMatchObject({ mode: 'car', durationSeconds: 600, departure: null, arrival: null, fare: null, transfers: null, lineName: null });
  });

  it('refuses departures outside the provider window without a call (日付範囲外)', async () => {
    const { p, fetchMock } = provider(() => json(transitRoute));
    const b = budget();
    expect(await p.route(req({ departureUtc: '2027-03-01T00:00:00Z' }), b)).toEqual({ leg: null, reason: 'out_of_date_range' }); // > 100 days
    expect(await p.route(req({ departureUtc: '2026-10-10T00:00:00Z' }), b)).toEqual({ leg: null, reason: 'out_of_date_range' }); // > 7 days ago
    expect(fetchMock).not.toHaveBeenCalled();
    expect(b.callsUsed).toBe(0);
    // Driving has no departure window: it is not timed.
    const car = await provider(() => json({ routes: [{ duration: '60s' }] })).p.route(req({ mode: 'car', departureUtc: '2027-03-01T00:00:00Z' }), budget());
    expect(car.reason).toBeNull();
  });

  it('refuses places without coordinates without a call', async () => {
    const { p, fetchMock } = provider(() => json(transitRoute));
    expect(await p.route(req({ to: { ...orsay, location: null } }), budget())).toEqual({ leg: null, reason: 'missing_location' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps provider and budget failures to reasons, never retrying 429, and rethrows cancellation', async () => {
    const limited = provider(() => json({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429));
    expect(await limited.p.route(req(), budget())).toEqual({ leg: null, reason: 'rate_limited' });
    expect(limited.fetchMock).toHaveBeenCalledTimes(1);

    const down = provider(() => json({}, 503));
    expect(await down.p.route(req(), budget())).toEqual({ leg: null, reason: 'provider_unavailable' });
    expect(down.fetchMock).toHaveBeenCalledTimes(2); // one bounded retry

    const offline = provider(() => {
      throw new TypeError('fetch failed: header X-Goog-Api-Key=test-key');
    });
    const r = await offline.p.route(req(), budget({ maxAttempts: 1 }));
    expect(r).toEqual({ leg: null, reason: 'provider_unavailable' });

    const empty = budget({ maxCalls: 0 });
    expect(await provider(() => json(transitRoute)).p.route(req(), empty)).toEqual({ leg: null, reason: 'rate_limited' });

    const cancelled = budget();
    cancelled.cancel();
    await expect(provider(() => json(transitRoute)).p.route(req(), cancelled)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not leak the API key through errors', async () => {
    const offline = provider(() => {
      throw new TypeError('fetch failed: header X-Goog-Api-Key=test-key');
    });
    const r = await offline.p.route(req(), budget({ maxAttempts: 1 }));
    expect(JSON.stringify(r)).not.toContain('test-key');
    expect(() => new GoogleRoutesProvider({ apiKey: '' })).toThrow();
  });
});

describe('parsing helpers', () => {
  it('reads durations and Money exactly, rejecting what it cannot read', () => {
    expect(parseDuration('1234s')).toBe(1234);
    expect(parseDuration('12.6s')).toBe(13);
    expect(parseDuration('PT5M')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(toMoney({ currencyCode: 'JPY', units: '210' })).toEqual({ amountMinor: 210, currency: 'JPY' });
    expect(toMoney({ currencyCode: 'EUR', units: 2, nanos: 150_000_000 })).toEqual({ amountMinor: 215, currency: 'EUR' });
    expect(toMoney({ currencyCode: 'KWD', units: '1', nanos: 234_000_000 })).toEqual({ amountMinor: 1234, currency: 'KWD' });
    for (const bad of [undefined, {}, { currencyCode: 'eur', units: '1' }, { currencyCode: 'EUR', units: '-1' }, { currencyCode: 'EUR', units: 'x' }, { currencyCode: 'XYZ1' }]) {
      expect(toMoney(bad as never), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('FixtureRouteProvider', () => {
  it('serves B04 legs for the same segment and mode, and no_route otherwise, without charging the budget', async () => {
    const b = budget();
    const p = new FixtureRouteProvider();
    const r = await p.route({ from: station, to: kenrokuen, departureUtc: '2026-11-01T00:30:00Z', mode: 'transit' }, b);
    expect(r.leg).toMatchObject({ legId: 'fx_leg_1', dataStatus: 'fixture', fare: { amountMinor: 200, currency: 'JPY' } });
    expect(await p.route({ from: station, to: kenrokuen, departureUtc: '2026-11-01T00:30:00Z', mode: 'car' }, b)).toEqual({ leg: null, reason: 'no_route' });
    expect(b.callsUsed).toBe(0);
  });
});
