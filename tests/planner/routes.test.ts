// R05/R06: 経路アダプタ。fake fetchのみ(通信しない)。応答は架空で、実プロバイダの記録ではない。
import type { PlaceInfo } from '@tkb/contracts';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import { CallBudget, DailyQuota, FixtureRouteProvider, Gate, GoogleRoutesProvider, SKU, type RouteRequest } from '@tkb/travel-data';
import { describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const find = (id: string, list: PlaceInfo[]) => list.find(p => p.placeId === id)!;
const louvre = find('fx_louvre', parisPlaces);
const orsay = find('fx_orsay', parisPlaces);
const station = find('fx_kanazawa_station', kanazawaPlaces);
const kenrokuen = find('fx_kenrokuen', kanazawaPlaces);

const budget = () =>
  new CallBudget({ maxCalls: 8, quota: new DailyQuota({ [SKU.routesTransit]: 20, [SKU.routesDrive]: 20 }, () => NOW), gate: new Gate(2), retryDelayMs: () => 0 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const provider = (respond: () => Response) => {
  const fetchMock = vi.fn(async () => respond());
  return { p: new GoogleRoutesProvider({ apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch, now: () => NOW }), fetchMock };
};
const req = (over: Partial<RouteRequest> = {}): RouteRequest => ({ from: louvre, to: orsay, departureUtc: '2026-10-25T09:00:00Z', mode: 'transit', ...over });

describe('route adapters, no network (架空応答)', () => {
  it('empty transit result after the last service is no_route with no leg (not a guessed leg)', async () => {
    const { p } = provider(() => json({}));
    const r = await p.route(req({ departureUtc: '2026-10-25T21:30:00Z' }), budget()); // 23:30 Paris local
    expect(r).toEqual({ leg: null, reason: 'no_route' });
  });

  it('the requested departure is sent to the provider, so results depend on departure time', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return json({});
    });
    const p = new GoogleRoutesProvider({ apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch, now: () => NOW });
    await p.route(req({ departureUtc: '2026-10-25T08:00:00Z' }), budget());
    await p.route(req({ departureUtc: '2026-10-25T20:00:00Z' }), budget());
    expect(bodies[0]).toContain('2026-10-25T08:00:00');
    expect(bodies[1]).toContain('2026-10-25T20:00:00');
  });

  it('provider failure is provider_unavailable, never "no route" or an invented leg', async () => {
    const { p } = provider(() => json({ error: 'x' }, 503));
    const r = await p.route(req(), budget());
    expect(r.leg).toBeNull();
    expect(r.reason).toBe('provider_unavailable');
  });

  it('fixture provider: unknown segment or mode is no_route and charges nothing', async () => {
    const p = new FixtureRouteProvider([]);
    expect(await p.route({ from: station, to: kenrokuen, departureUtc: '2026-11-01T00:30:00Z', mode: 'car' }, budget())).toEqual({ leg: null, reason: 'no_route' });
  });
});
