// A04 independent, spec-driven tests (CONTRACTS K05/K07, CLAUDE.md §2, M1 decisions D-1/D-2 on #28).
// Fake Google data only; the real shared app (in-memory DB) stores the batch. No network, no real Claude.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildPrompt, type Runner } from '@tkb/ai';
import { PlanBatch, PlanBatchCreate, PlanningContext, type Activity, type GenerationInput, type PlaceInfo, type PlanBlueprint, type PlanningContextRequest, type TravelLeg, type TripConstraints } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { kanazawaPlaces } from '@tkb/fixtures';
import { buildApp as buildShared } from '../../server/src/platform/app.ts';
import { hashPassword } from '../../server/src/platform/auth/password.ts';
import { loadConfig as loadShared } from '../../server/src/platform/config.ts';
import { JobManager, type JobRequest } from '../src/jobs/index.ts';
import { createPipeline } from '../src/generation/pipeline.ts';
import { LEG_REFETCH_WARNING, INSUFFICIENT_PLACE_WARNING } from '../src/generation/project.ts';
import { createContextClient, createPlanBatchClient, type ContextClient, type FetchLike } from '../src/shared-client/index.ts';

const PW = 'correct horse battery';
const S = { NAME: 'GOOGLE_NAME_SENTINEL', DESC: 'GOOGLE_DESC_SENTINEL', HOURS: 'GOOGLE_HOURS_SENTINEL 9:00-17:00', LINE: 'LINE_SENTINEL', PLAT: 'PLATFORM_SENTINEL', ADDR: 'GOOGLE_ADDR_SENTINEL' };
const SENTINEL_RE = /GOOGLE_[A-Z]+_SENTINEL|LINE_SENTINEL|PLATFORM_SENTINEL|9999|36\.5123|136\.6789/;
const closers: { close(): Promise<unknown> }[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
});

const GOOGLE_PLACES = { source: 'google_places', fetchedAt: '2026-10-24T00:00:00Z', attribution: 'Google Maps', maySendToModel: false, mayStore: false, mayExport: false, retainUntil: '2026-10-24T00:00:00Z' } as const;
const GOOGLE_ROUTES = { ...GOOGLE_PLACES, source: 'google_routes' } as const;
const sentinelPlace = (p: PlaceInfo): PlaceInfo => ({ ...p, name: `${S.NAME}_${p.placeId}`, description: S.DESC, openingHours: S.HOURS, location: { lat: 36.5123, lng: 136.6789 }, provenance: GOOGLE_PLACES, dataStatus: 'verified' });
const sentinelLeg = (from: string, to: string, mode: TravelLeg['mode'] = 'transit'): TravelLeg => ({
  type: 'leg', legId: `lv_${from}_${to}`, mode, fromPlaceId: from, toPlaceId: to, departure: { utc: '2026-11-01T00:05:00Z', timeZone: 'Asia/Tokyo' }, arrival: { utc: '2026-11-01T00:25:00Z', timeZone: 'Asia/Tokyo' },
  durationSeconds: 1200, lineName: S.LINE, platform: S.PLAT, transfers: 2, fare: { amountMinor: 9999, currency: 'JPY' }, dataStatus: 'verified', provenance: GOOGLE_ROUTES,
});

const constraints = (over: Partial<TripConstraints> = {}): TripConstraints => ({
  area: '金沢', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'transit',
  departure: { placeId: 'fx_kanazawa_station', label: null, time: null }, ...over,
});
const bp = (...orders: string[][]): PlanBlueprint => ({ schemaVersion: 1, candidates: orders.map((o, i) => ({ candidateId: `c${i + 1}`, activityOrder: o, reasons: [], warnings: [] })) });

function shared() {
  const db = openDatabase(':memory:');
  migrate(db);
  createUser(db, { id: 'user_a', loginId: 'user-a', passwordHash: pwHash, displayName: 'A', createdAt: '2026-10-24T03:00:00Z' });
  const app = buildShared({ config: { ...loadShared({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
  closers.push(app);
  return { app, db };
}
const bridge = (server: ReturnType<typeof shared>['app']): FetchLike => async (url, init) => {
  const u = new URL(url);
  const res = await server.inject({ method: init.method as 'GET' | 'POST', url: u.pathname + u.search, payload: init.body as string | undefined, headers: init.headers as Record<string, string> });
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach(x => h.append(k, x));
    else if (v !== undefined) h.set(k, String(v));
  }
  return new Response(res.body, { status: res.statusCode, headers: h });
};

/** A job manager over the real pipeline, a capturing runner, the real shared app for K07, and a chosen K05 client. */
async function harness(contextClient: ContextClient | null, blueprint: PlanBlueprint, runnerOverride?: Runner) {
  const { app, db } = shared();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const csrf = login.json().csrfToken as string;
  const hdr = { cookie, 'x-csrf-token': csrf };
  const upstream = { userId: 'user_a', displayName: 'A', cookie, csrfToken: csrf };
  const session = { id: 's', csrfToken: 'x', expiresAt: Date.now() + 1e9, upstream };
  const fetch = bridge(app);
  const inputs: GenerationInput[] = [];
  const runner: Runner = runnerOverride ?? {
    run: async input => {
      inputs.push(input);
      return { exitCode: 0, envelope: { type: 'result', subtype: 'success', is_error: false, structured_output: blueprint }, durationMs: 1 };
    },
  };
  const pipeline = createPipeline({
    contextClient: contextClient ?? createContextClient({ baseUrl: 'http://shared', fetch }),
    planClient: createPlanBatchClient({ baseUrl: 'http://shared', fetch }),
    sessions: { findUpstream: () => session },
  });
  const manager = new JobManager({ runner, queueLimit: 4, timeoutMs: 5000, pipeline });
  let n = 0;
  const run = async (c: TripConstraints, key = `key-ind-${++n}-00000`) => {
    const req: JobRequest = { constraints: c, baseTripId: null, baseRevision: null };
    const r = manager.submit('user_a', key, JSON.stringify(c), req);
    if (r.kind !== 'accepted') throw new Error(r.kind);
    for (let i = 0; i < 300; i++) {
      const s = manager.status('user_a', r.jobId)!;
      if (s.state === 'succeeded' || s.state === 'failed' || s.state === 'cancelled') { return s; }
      await new Promise(res => setTimeout(res, 10));
    }
    throw new Error('did not settle');
  };
  const stored = async (batchId: string) => {
    const r = await app.inject({ url: `/api/v1/plan-batches/${batchId}`, headers: hdr });
    if (r.statusCode !== 200) throw new Error(`GET ${r.statusCode} ${r.body}`);
    return { raw: r.body, batch: PlanBatch.parse(r.json()) };
  };
  const rows = () => (db.prepare('SELECT COUNT(*) AS n FROM plan_batches').get() as { n: number }).n;
  return { app, db, manager, run, stored, inputs, rows, hdr, pipeline, session, fetch };
}

/** A K05 client that serves the given places (and, once asked, sentinel legs for the asked segments). */
function fakeClient(mode: 'live' | 'mixed', places: PlaceInfo[], seen: PlanningContextRequest[] = []): ContextClient {
  return {
    getPlanningContext: async (_s, body) => {
      seen.push(body);
      const legs = (body.legs ?? []).map(q => sentinelLeg(q.fromPlaceId, q.toPlaceId, q.mode));
      return { ok: true, context: PlanningContext.parse({ places, legs, unknown: legs.length ? [] : ['legs'], dataMode: mode }) };
    },
  };
}
const liveItems = (b: PlanBatch) => b.candidates.flatMap(c => c.days.flatMap(d => d.items));

describe('no Google content leaks (live: sentinel places + sentinel legs)', () => {
  const places = kanazawaPlaces.map(p => (p.kind === 'station' ? p : sentinelPlace(p)));
  const mustVisit = ['fx_kenrokuen'];

  it('live: model prompt, stored batch, job status and totals contain no sentinel; only ids reach the model', async () => {
    const h = await harness(fakeClient('live', places), bp(['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho']));
    const job = await h.run(constraints({ mustVisit }));
    expect(job.state).toBe('succeeded');
    expect(h.inputs).toHaveLength(1);
    const input = h.inputs[0]!;
    expect(JSON.stringify(input)).not.toMatch(SENTINEL_RE);
    expect(buildPrompt(input)).not.toMatch(SENTINEL_RE);
    expect(input.allowedPlaceIds).toEqual(expect.arrayContaining(['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho']));
    expect(input.facts.every(f => f.kind !== 'place' || f.place.provenance.maySendToModel)).toBe(true);
    expect(JSON.stringify(job)).not.toMatch(SENTINEL_RE);

    const { raw, batch } = await h.stored(job.batchId!);
    expect(raw).not.toMatch(SENTINEL_RE);
    expect(JSON.stringify(batch)).not.toMatch(SENTINEL_RE);
    for (const c of batch.candidates) {
      expect(c.validationState).not.toBe('valid'); // pure live with no usable place info is never "valid"
      expect(c.warnings.join('\n')).toContain(INSUFFICIENT_PLACE_WARNING);
      expect(c.totalKnownCost).toEqual([]);
      expect(c.hasUnknownCost).toBe(true);
    }
  });

  it('live: a place content is replaced by id-only stubs (no coordinates, hours or description) in the stored places', async () => {
    const h = await harness(fakeClient('live', places), bp(['fx_kenrokuen', 'fx_omicho']));
    const job = await h.run(constraints({ mustVisit }));
    const { batch } = await h.stored(job.batchId!);
    for (const p of batch.places.filter(x => x.placeId !== 'fx_kanazawa_station')) {
      expect(p.location).toBeNull();
      expect(p.openingHours).toBeNull();
      expect(p.description).toBeNull();
      expect(p.photo).toBeNull();
      expect(p.provenance.maySendToModel).toBe(false);
      expect(p.provenance.mayExport).toBe(false);
    }
  });

  it('mixed: fixture places + live legs; leg detail is null in the stored batch and in no prompt/status/total', async () => {
    const seen: PlanningContextRequest[] = [];
    const fixturePlaces = structuredClone(kanazawaPlaces);
    const h = await harness(fakeClient('mixed', fixturePlaces, seen), bp(['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho'], ['fx_omicho', 'fx_kenrokuen']));
    const job = await h.run(constraints({ mustVisit }));
    expect(job.state).toBe('succeeded');
    expect(seen.some(s => (s.legs ?? []).length > 0)).toBe(true); // the live second call really happened
    expect(seen.every(s => (s.legs ?? []).length <= 8)).toBe(true);
    const input = h.inputs[0]!;
    expect(JSON.stringify(input)).not.toMatch(SENTINEL_RE);
    expect(buildPrompt(input)).not.toMatch(SENTINEL_RE);
    expect(JSON.stringify(job)).not.toMatch(SENTINEL_RE);
    const { raw, batch } = await h.stored(job.batchId!);
    expect(raw).not.toMatch(SENTINEL_RE);
    const legs = liveItems(batch).filter((i): i is TravelLeg => i.type === 'leg');
    expect(legs.length).toBeGreaterThan(0);
    for (const l of legs) {
      expect(l).toMatchObject({ durationSeconds: null, fare: null, lineName: null, platform: null, transfers: null, departure: null, arrival: null });
    }
    for (const c of batch.candidates) {
      if (c.days.some(d => d.items.some(i => i.type === 'leg'))) expect(c.warnings).toContain(LEG_REFETCH_WARNING);
      expect(c.totalKnownCost.every(m => m.amountMinor !== 9999)).toBe(true);
      expect(c.hasUnknownCost).toBe(true);
    }
  });

  it('mixed: when the live leg lookup returns only some segments, a stop without a known leg gets no time and no leg item', async () => {
    const places2 = structuredClone(kanazawaPlaces);
    const client: ContextClient = {
      getPlanningContext: async (_s, body) => {
        const legs = (body.legs ?? []).filter(q => q.toPlaceId === 'fx_kenrokuen').map(q => sentinelLeg(q.fromPlaceId, q.toPlaceId, q.mode));
        return { ok: true, context: PlanningContext.parse({ places: places2, legs, unknown: ['legs'], dataMode: 'mixed' }) };
      },
    };
    const h = await harness(client, bp(['fx_kenrokuen', 'fx_omicho', 'fx_higashi']));
    const job = await h.run(constraints());
    expect(job.state).toBe('succeeded');
    const { batch } = await h.stored(job.batchId!);
    for (const c of batch.candidates) {
      for (const d of c.days) {
        const items = d.items;
        items.forEach((it, i) => {
          if (it.type !== 'activity' || i === 0) return;
          const prev = items[i - 1]!;
          if (prev.type === 'activity') expect(it.start, `${it.placeId} follows an activity with no leg`).toBeNull(); // travel unknown => no invented time
        });
      }
    }
    expect(JSON.stringify(batch)).not.toMatch(SENTINEL_RE);
  });

  it('a failed K05 (rate limit text with sentinel) never reaches status or the runner', async () => {
    const client: ContextClient = { getPlanningContext: async () => ({ ok: false, code: 'PROVIDER_RATE_LIMIT', retryable: false }) };
    const h = await harness(client, bp(['fx_kenrokuen']));
    const job = await h.run(constraints());
    expect(job).toMatchObject({ state: 'failed', stage: 'collecting_context', error: { code: 'PROVIDER_RATE_LIMIT' } });
    expect(h.inputs).toHaveLength(0);
    expect(h.rows()).toBe(0);
  });
});

describe('fixture mode: nothing is invented', () => {
  it('stored legs carry no platform; unknown fixture leg has no duration; unknown costs stay null and flagged', async () => {
    const h = await harness(null, bp(['fx_kenrokuen', 'fx_21c_museum', 'fx_sushi']));
    const job = await h.run(constraints({ mustVisit: ['fx_kenrokuen'] }));
    expect(job.state).toBe('succeeded');
    const { batch } = await h.stored(job.batchId!);
    for (const c of batch.candidates) {
      expect(c.hasUnknownCost).toBe(true); // the museum admission and others are unknown
      for (const it of c.days.flatMap(d => d.items)) {
        if (it.type === 'leg') {
          expect(it.platform).toBeNull();
          expect(it.transfers ?? null).toBeNull();
          if (it.fromPlaceId === 'fx_21c_museum' && it.toPlaceId === 'fx_sushi') expect(it.durationSeconds).toBeNull();
          if (it.fromPlaceId === 'fx_kenrokuen' && it.toPlaceId === 'fx_21c_museum') expect(it.fare).toBeNull(); // a walk: no fare made up
        } else if (it.placeId === 'fx_21c_museum') expect(it.cost).toBeNull();
      }
      // the total only sums known amounts: never more than the sum of the fixture amounts present
      const sum = c.days.flatMap(d => d.items).reduce((a, it) => a + ((it.type === 'activity' ? it.cost : it.fare)?.amountMinor ?? 0), 0);
      expect(c.totalKnownCost.reduce((a, m) => a + m.amountMinor, 0)).toBe(sum);
    }
  });

  it('every timed activity is preceded by a known (non-null duration or start) basis: unknown leg => untimed', async () => {
    const h = await harness(null, bp(['fx_21c_museum', 'fx_sushi']));
    const job = await h.run(constraints({ departure: { placeId: 'fx_21c_museum', label: null, time: null } }));
    const { batch } = await h.stored(job.batchId!);
    for (const c of batch.candidates) {
      const items = c.days.flatMap(d => d.items);
      const sushi = items.find((i): i is Activity => i.type === 'activity' && i.placeId === 'fx_sushi');
      if (sushi) expect(sushi.start).toBeNull(); // fx_leg_3 (museum -> sushi) is unknown in the fixtures
    }
  });
});

describe('pipeline guarantees', () => {
  it('a runner output with a place outside allowedPlaceIds is rejected, nothing is saved', async () => {
    const h = await harness(null, bp(['fx_kenrokuen', 'not_offered_place']));
    const job = await h.run(constraints());
    expect(job).toMatchObject({ state: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(h.rows()).toBe(0);
  });

  it('a station (not visitable) in activityOrder is rejected', async () => {
    const h = await harness(null, bp(['fx_kanazawa_station', 'fx_kenrokuen']));
    const job = await h.run(constraints());
    expect(job.state).toBe('failed');
    expect(h.rows()).toBe(0);
  });

  it('K05 failure: the runner is never called (area outside fixtures => constraint unsatisfied)', async () => {
    const h = await harness(null, bp(['fx_kenrokuen']));
    const job = await h.run(constraints({ area: 'Atlantis' }));
    expect(job).toMatchObject({ state: 'failed', stage: 'collecting_context' });
    expect(h.inputs).toHaveLength(0);
    expect(h.rows()).toBe(0);
  });

  it('a trip longer than the limit fails before K05/runner', async () => {
    const h = await harness(null, bp(['fx_kenrokuen']));
    const job = await h.run(constraints({ startDate: '2026-11-01', endDate: '2026-12-31' }));
    expect(job.state).toBe('failed');
    expect(h.inputs).toHaveLength(0);
  });

  it('must-visit id unknown to K05 fails before the runner (never plans without it)', async () => {
    const h = await harness(null, bp(['fx_kenrokuen']));
    const job = await h.run(constraints({ mustVisit: ['fx_nowhere'] }));
    expect(job.state).toBe('failed');
    expect(h.inputs).toHaveLength(0);
  });

  it('deterministic: the same inputs and operation key build a byte-identical K07 body; replaying the save returns the same batchId', async () => {
    const h = await harness(null, bp(['fx_kenrokuen', 'fx_21c_museum'], ['fx_higashi', 'fx_omicho']));
    const col = await h.pipeline.collect('user_a', { constraints: constraints(), baseTripId: null, baseRevision: null }, new AbortController().signal);
    if (!col.ok) throw new Error(col.code);
    const sig = new AbortController().signal;
    const b1 = await h.pipeline.build('user_a', bp(['fx_kenrokuen', 'fx_21c_museum'], ['fx_higashi', 'fx_omicho']), col.ctx, 'k'.repeat(64), sig);
    const b2 = await h.pipeline.build('user_a', bp(['fx_kenrokuen', 'fx_21c_museum'], ['fx_higashi', 'fx_omicho']), col.ctx, 'k'.repeat(64), sig);
    if (!b1.ok || !b2.ok) throw new Error('build');
    expect(JSON.stringify(b1.batch)).toBe(JSON.stringify(b2.batch));
    PlanBatchCreate.parse(b1.batch);
    const s1 = await h.pipeline.save('user_a', b1.batch, sig);
    const s2 = await h.pipeline.save('user_a', b2.batch, sig);
    expect(s2.batchId).toBe(s1.batchId);
    expect(h.rows()).toBe(1);
    const other = await h.pipeline.build('user_a', bp(['fx_kenrokuen', 'fx_21c_museum']), col.ctx, 'z'.repeat(64), sig);
    if (!other.ok) throw new Error('build');
    expect(other.batch.generationId).not.toBe(b1.batch.generationId);
  });

  it('double submit with the same Idempotency-Key: one job, one run, one batch', async () => {
    const h = await harness(null, bp(['fx_kenrokuen', 'fx_21c_museum']));
    const c = constraints();
    const a = await h.run(c, 'same-key-000001');
    const b = await h.run(c, 'same-key-000001');
    expect(b.jobId).toBe(a.jobId);
    expect(b.batchId).toBe(a.batchId);
    expect(h.inputs).toHaveLength(1);
    expect(h.rows()).toBe(1);
  });

  it('same key with different constraints is a conflict, not a second batch', async () => {
    const h = await harness(null, bp(['fx_kenrokuen']));
    const c = constraints();
    await h.run(c, 'same-key-000002');
    const r = h.manager.submit('user_a', 'same-key-000002', JSON.stringify({ ...c, area: 'Paris' }), { constraints: { ...c, area: 'Paris' }, baseTripId: null, baseRevision: null });
    expect(r.kind).toBe('conflict');
    expect(h.rows()).toBe(1);
  });
});
