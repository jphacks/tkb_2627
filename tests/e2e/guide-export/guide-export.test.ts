// I05: 現地ガイドと出力の統合 (numbered map, descriptions, amenities, PDF, ICS, Maps links) against a real server process.
// Real apps/server child process, temp file DB, fixture provider, ALLOW_CLAUDE_EXECUTION=false, PUBLIC_ORIGIN empty.
// No .env, no Google, no external API. The web clients (guide/print/itinerary) run with a cookie-jar fetch.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlanBatchCreated, Trip, TripWriteResult, type Activity, type PlaceInfo, type PlanCandidate, type Provenance, type TravelLeg, type TripDay } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import { tripMapsLinks, tripToIcs } from '@tkb/exports';
import { hashPassword } from '../../../apps/server/src/platform/auth/password.ts';
import { buildPrintModel as serverPrintModel } from '../../../apps/server/src/platform/exports/print-model.ts';
import { buildPrintModel as webPrintModel } from '../../../apps/web/src/screens/print/model.ts';
import { createPdf } from '../../../apps/web/src/screens/print/pdf.ts';
import { mapPoints, unlocatedPlaces } from '../../../apps/web/src/screens/itinerary/model.ts';
import {
  FICTION_LABEL, NO_DESCRIPTION, SHELTER_WARNING, UNSUPPORTED_TEXT, bboxAround, chooseArea, displayName, fallbackBbox, fetchAmenities, spotDetail, warningFor,
  type Bbox,
} from '../../../apps/web/src/screens/guide/model.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PW = 'correct horse battery';
const NOW = '2026-10-24T03:00:00Z';
const dir = mkdtempSync(join(tmpdir(), 'tkb-e2e-ge-'));
const dbPath = join(dir, 'travel.sqlite');
let child: ChildProcess | null = null;
let base = '';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}
async function startServer(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const c = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env, DATABASE_PATH: dbPath, SHARED_PORT: String(port), SHARED_BIND: '127.0.0.1', PROVIDER_MODE: 'fixture',
      ALLOW_CLAUDE_EXECUTION: 'false', SESSION_SECRET: 'g'.repeat(48), PUBLIC_ORIGIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = c;
  await new Promise<void>((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error(`server did not start: ${out}`)), 30_000);
    c.stdout!.on('data', (b: Buffer) => {
      out += b.toString();
      if (out.includes('listening on')) { clearTimeout(t); res(); }
    });
    c.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    c.once('exit', code => { clearTimeout(t); rej(new Error(`server exited early (${code}): ${out}`)); });
  });
}
async function stopServer(): Promise<void> {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  await new Promise<void>(res => { c.once('exit', () => res()); c.kill('SIGTERM'); });
}

/** Cookie jar over fetch: relative URLs are resolved against the child server, the session cookie is replayed. */
const jar = { cookie: '' };
let csrf = '';
const f = (input: string, init: RequestInit = {}): Promise<Response> =>
  fetch(input.startsWith('http') ? input : `${base}${input}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...(jar.cookie ? { cookie: jar.cookie } : {}) },
  });
const sendJson = (method: string, path: string, payload: unknown) =>
  f(path, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(payload) });

// ---- Trip built for this test: two zones, a home address, restricted and credited photos ----
const TOKYO = 'Asia/Tokyo';
const PARIS = 'Europe/Paris';
const prov = (over: Partial<Provenance> = {}): Provenance => ({
  source: 'fixture', fetchedAt: null, attribution: 'tkb_2627 fixture', maySendToModel: true, mayStore: true, mayExport: true, retainUntil: null, ...over,
});
const HOME_ADDRESS = '東京都千代田区丸の内9-9-9 山田邸';
const place = (placeId: string, name: string, kind: PlaceInfo['kind'], lat: number, lng: number, timeZone: string, extra: Partial<PlaceInfo> = {}): PlaceInfo => ({
  placeId, name, kind, location: { lat, lng }, timeZone, openingHours: null, description: null, photo: null, dataStatus: 'fixture', provenance: prov(), ...extra,
});
const station = kanazawaPlaces.find(p => p.placeId === 'fx_kanazawa_station')!;
const ken = kanazawaPlaces.find(p => p.placeId === 'fx_kenrokuen')!;
const places: PlaceInfo[] = [
  place('ge_home', HOME_ADDRESS, 'other', 35.68, 139.76, TOKYO),
  station,
  { ...ken, photo: { url: 'https://example.invalid/ken.jpg', attribution: '撮影: 架空太郎', license: 'CC BY 4.0' } },
  // provider forbids export; it also has a (credited) photo
  place('ge_restricted', '（架空）転載不可の庭', 'spot', 36.563, 136.657, TOKYO, {
    description: '転載不可の解説', openingHours: '9:00-17:00',
    photo: { url: 'https://example.invalid/r.jpg', attribution: '撮影: 制限花子', license: null },
    provenance: prov({ source: 'fixture:restricted', attribution: '制限出典', mayExport: false }),
  }),
  // exportable place whose photo has no real author (blank after trim)
  place('ge_noauthor', '（架空）作者不明の茶屋', 'area', 36.572, 136.666, TOKYO, { photo: { url: 'https://example.invalid/na.jpg', attribution: '  ', license: null } }),
  place('ge_untimed', '（架空）時刻未定の市場', 'area', 36.571, 136.656, TOKYO),
  place('ge_nolocation', '（架空）位置不明の店', 'restaurant', 36.5, 136.6, TOKYO, { location: null }),
  ...parisPlaces.filter(p => p.placeId === 'fx_orsay'),
];
function act(activityId: string, title: string, tz: string, s: string | null, e: string | null, extra: Partial<Activity> = {}): Activity {
  return {
    type: 'activity', activityId, kind: 'visit', title, placeId: null, areaName: null,
    start: s ? { utc: s, timeZone: tz } : null, end: e ? { utc: e, timeZone: tz } : null,
    fixed: false, status: 'planned', cost: null, costStatus: 'unknown', privateNotes: '秘密のメモ-ZZZ', ...extra,
  };
}
function leg(legId: string, from: string, to: string, tz: string, s: string | null, e: string | null, extra: Partial<TravelLeg> = {}): TravelLeg {
  return {
    type: 'leg', legId, mode: 'transit', fromPlaceId: from, toPlaceId: to,
    departure: s ? { utc: s, timeZone: tz } : null, arrival: e ? { utc: e, timeZone: tz } : null,
    durationSeconds: s && e ? (Date.parse(e) - Date.parse(s)) / 1000 : null, lineName: null, platform: null, transfers: null,
    fare: null, dataStatus: 'fixture', provenance: prov(), ...extra,
  };
}
const candidate: PlanCandidate = {
  candidateId: 'cand_ge',
  title: '金沢とパリ（I05）',
  days: [
    {
      date: '2026-10-25', timeZone: PARIS,
      items: [
        // 01:30Z is the second 02:30 of the day in Paris (DST ended at 01:00Z): must be written in UTC.
        act('ge_a_late', '夜更かしの散歩', PARIS, '2026-10-25T01:30:00Z', '2026-10-25T02:00:00Z'),
        act('ge_a_orsay', 'オルセー美術館', PARIS, '2026-10-25T09:00:00Z', '2026-10-25T11:00:00Z', { placeId: 'fx_orsay' }),
      ],
    },
    {
      date: '2026-11-01', timeZone: TOKYO,
      items: [
        leg('ge_l_home', 'ge_home', 'fx_kanazawa_station', TOKYO, '2026-11-01T00:00:00Z', '2026-11-01T00:20:00Z'),
        act('ge_a_ken', '兼六園を散策', TOKYO, '2026-11-01T01:00:00Z', '2026-11-01T02:30:00Z', { placeId: 'fx_kenrokuen', cost: { amountMinor: 320, currency: 'JPY' }, costStatus: 'fixture' }),
        act('ge_a_res', '転載不可の庭', TOKYO, '2026-11-01T02:40:00Z', '2026-11-01T03:40:00Z', { placeId: 'ge_restricted' }),
        leg('ge_l_res', 'ge_restricted', 'ge_noauthor', TOKYO, '2026-11-01T03:45:00Z', '2026-11-01T04:00:00Z', { provenance: prov({ mayExport: false, source: 'fixture:restricted-leg' }) }),
        act('ge_a_na', '作者不明の茶屋', TOKYO, '2026-11-01T04:10:00Z', '2026-11-01T05:00:00Z', { placeId: 'ge_noauthor' }),
        act('ge_a_untimed', '時刻未定の市場', TOKYO, null, null, { placeId: 'ge_untimed', kind: 'free_walk' }),
        act('ge_a_noloc', '位置不明の店', TOKYO, '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', { placeId: 'ge_nolocation', kind: 'meal' }),
        leg('ge_l_home2', 'ge_nolocation', 'ge_home', TOKYO, '2026-11-01T07:10:00Z', null, { dataStatus: 'unknown', provenance: null }),
      ],
    },
  ],
  reasons: ['i05'], warnings: [], excludedPlaceIds: [], totalKnownCost: [{ amountMinor: 320, currency: 'JPY' }], hasUnknownCost: true, validationState: 'needs_review',
};
const constraints = {
  area: '金沢', startDate: '2026-10-25', endDate: '2026-11-01', timeZone: TOKYO, transportMode: 'transit' as const,
  departure: { placeId: 'ge_home', label: null, time: null }, return: { placeId: 'ge_home', label: null, time: null },
};

let trip: Trip;

beforeAll(async () => {
  const db = openDatabase(dbPath);
  migrate(db);
  const hash = await hashPassword(PW);
  createUser(db, { id: 'user_ge', loginId: 'user-ge', passwordHash: hash, displayName: 'ge', createdAt: NOW });
  createUser(db, { id: 'user_other', loginId: 'user-other', passwordHash: hash, displayName: 'other', createdAt: NOW });
  db.close();
  await startServer();
  const res = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'user-ge', password: PW }) });
  expect(res.status).toBe(200);
  csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
  jar.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;

  const created = await sendJson('POST', '/api/v1/plan-batches', {
    schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'gen_i05', candidates: [candidate], places, constraints,
  });
  expect(created.status).toBe(201);
  const batch = PlanBatchCreated.parse(await created.json());
  const applied = await sendJson('POST', '/api/v1/trips/apply-candidate', { batchId: batch.batchId, candidateId: 'cand_ge', tripId: null, expectedRevision: null });
  expect(applied.status).toBe(201);
  const w = TripWriteResult.parse(await applied.json());
  trip = Trip.parse(await (await f(`/api/v1/trips/${w.tripId}`)).json());
}, 60_000);

afterAll(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

const day = (date: string) => trip.days.find(d => d.date === date)!;
const bboxQs = (b: Bbox) => `bbox=${b.south},${b.west},${b.north},${b.east}`;
/** The day without the legs that touch the home place (departure/return): what a guide at the destination is about. */
const destinationDay = (): TripDay => {
  const d = day('2026-11-01');
  return { ...d, items: d.items.filter(i => !(i.type === 'leg' && (i.fromPlaceId === 'ge_home' || i.toPlaceId === 'ge_home'))) };
};
const denied = { getCurrentPosition: (_ok: unknown, err: (e: { code: number; message: string }) => void) => err({ code: 1, message: 'denied' }) };

describe('I05 scenario 1: guide (numbered map, descriptions, amenities)', () => {
  it('numbered points of the saved trip follow visit order; unlocated places are listed apart, never at 0,0', () => {
    const d = day('2026-11-01');
    const pts = mapPoints(d, trip.places);
    // Independent derivation: first appearance over items (leg from/to, activity place) that have a location.
    const order: string[] = [];
    for (const it of d.items) {
      for (const id of it.type === 'leg' ? [it.fromPlaceId, it.toPlaceId] : it.placeId ? [it.placeId] : []) {
        const p = trip.places.find(x => x.placeId === id);
        if (p?.location && !order.includes(id)) order.push(id);
      }
    }
    expect(order.length).toBeGreaterThan(3);
    expect(pts.map(p => p.placeId)).toEqual(order);
    expect(pts.map(p => p.number)).toEqual(pts.map((_, i) => i + 1));
    expect(pts.some(p => p.lat === 0 && p.lng === 0)).toBe(false);
    expect(unlocatedPlaces(d, trip.places).map(u => u.name)).toEqual(['（架空）位置不明の店']);
    expect(mapPoints(day('2026-10-25'), trip.places).map(p => [p.number, p.placeId])).toEqual([[1, 'fx_orsay']]);
  });

  it('spot details: description from Trip.places, 解説なし when absent (never generated)', () => {
    const pts = mapPoints(day('2026-11-01'), trip.places);
    const k = spotDetail(pts.find(p => p.placeId === 'fx_kenrokuen')!, trip.places);
    expect(k.hasDescription).toBe(true);
    expect(k.description).toContain('日本三名園');
    expect(k.fictional).toBe(true);
    const market = spotDetail(pts.find(p => p.placeId === 'ge_untimed')!, trip.places);
    expect(market.description).toBe(NO_DESCRIPTION);
    expect(market.hasDescription).toBe(false);
    expect(market.photo).toBeNull();
  });

  it('amenities near Kanazawa: toilets, sites and shelters are separate kinds, 【架空】, shelter warning, openNow null', async () => {
    const area = await chooseArea({ useDevice: false, geo: undefined, day: destinationDay(), places: trip.places });
    expect(area.source).toBe('trip');
    if (area.source === 'none') throw new Error('no area');
    const r = await fetchAmenities(area.bbox, { fetch: f });
    expect(r.state).toBe('ok');
    if (r.state !== 'ok') return;
    expect([...new Set(r.items.map(i => i.kind))].sort()).toEqual(['evacuation_shelter', 'evacuation_site', 'toilet']);
    for (const i of r.items) {
      expect(i.openNow).toBeNull();
      expect(i.provenance.source.startsWith('fixture')).toBe(true);
      expect(displayName(i).startsWith(FICTION_LABEL)).toBe(true);
      if (i.kind === 'toilet') expect(warningFor(i)).toBeNull();
      else expect(warningFor(i)).toContain(SHELTER_WARNING);
    }
    const only = (await (await f(`/api/v1/amenities?${bboxQs(area.bbox)}&kind=toilet`)).json()) as { items: { kind: string }[] };
    expect(only.items.length).toBeGreaterThan(0);
    expect(only.items.every(i => i.kind === 'toilet')).toBe(true);
  });

  it('Paris is unsupported_region (200, explicit, not an empty ok); an oversized bbox is 422', async () => {
    const paris = bboxAround({ lat: 48.86, lng: 2.33 });
    const res = await f(`/api/v1/amenities?${bboxQs(paris)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dataStatus: string; items: unknown[] };
    expect(body.dataStatus).toBe('unsupported_region');
    expect(body.items).toEqual([]);
    expect((await fetchAmenities(paris, { fetch: f })).state).toBe('unsupported');
    expect(UNSUPPORTED_TEXT).toBeTruthy();
    expect((await f('/api/v1/amenities?bbox=36,136,37,137')).status).toBe(422);
    expect((await f('/api/v1/amenities?bbox=nope')).status).toBe(422);
    expect((await fetchAmenities({ south: 36, west: 136, north: 37, east: 137 }, { fetch: f })).state).toBe('error');
  });

  it('denied GPS: the fallback area comes from the trip places, still returns results, one request only', async () => {
    const seen: string[] = [];
    const spy = (input: string, init?: RequestInit) => { seen.push(input); return f(input, init); };
    const area = await chooseArea({ useDevice: true, geo: denied as never, day: destinationDay(), places: trip.places });
    expect(area.source).toBe('trip');
    expect(area.deviceFailure).toBe('denied');
    if (area.source === 'none') throw new Error('no area');
    expect(area.bbox).toEqual(fallbackBbox(destinationDay(), trip.places));
    const r = await fetchAmenities(area.bbox, { fetch: spy });
    expect(r.state).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith('/api/v1/amenities?bbox=')).toBe(true);
    // A day without any located place gives no area (no guess).
    const none = await chooseArea({ useDevice: true, geo: denied as never, day: { date: '2026-11-03', timeZone: TOKYO, items: [] }, places: trip.places });
    expect(none.source).toBe('none');
  });
});

describe('I05 finding: fallback area with a home leg', () => {
  // FINDING: fallbackBbox averages every located place of the day, including the departure/return place (home) that a
  // leg touches. For a day that starts with home -> station, the centroid lands between Tokyo and Kanazawa, outside the
  // supported region and nowhere near the traveller. Expected: the search area contains the destination stops.
  it.fails('the fallback bbox of a day that starts at home still contains the destination stops', () => {
    const b = fallbackBbox(day('2026-11-01'), trip.places)!;
    const st = trip.places.find(p => p.placeId === 'fx_kanazawa_station')!.location!;
    expect(st.lat >= b.south && st.lat <= b.north && st.lng >= b.west && st.lng <= b.east).toBe(true);
  });
});

describe('I05 scenario 2: PDF export', () => {
  it('owner POST then poll yields application/pdf with a %PDF header; withheld matches mayExport=false', async () => {
    const out = await createPdf(trip.tripId, trip.revision, { fetch: f, sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 50))) });
    expect(out.state).toBe('ready');
    if (out.state !== 'ready') return;
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
    const expected = new Set<string>();
    for (const p of trip.places) if (!p.provenance.mayExport) { expected.add(`place:${p.placeId}`); if (p.photo) expected.add(`photo:${p.placeId}`); }
    for (const d of trip.days) for (const it of d.items) if (it.type === 'leg' && it.provenance && !it.provenance.mayExport) expected.add(`leg:${it.legId}`);
    expect(new Set(out.withheld.map(w => `${w.kind}:${w.id}`))).toEqual(expected);
  });

  it('another user gets 404 on the export; a stale revision is a conflict', async () => {
    const lr = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'user-other', password: PW }) });
    const token = ((await lr.json()) as { csrfToken: string }).csrfToken;
    const res = await fetch(`${base}/api/v1/trips/${trip.tripId}/exports`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: (lr.headers.get('set-cookie') ?? '').split(';')[0]! },
      body: JSON.stringify({ expectedRevision: trip.revision, format: 'pdf' }),
    });
    expect(res.status).toBe(404);
    const stale = await createPdf(trip.tripId, trip.revision + 5, { fetch: f, sleep: async () => {} });
    expect(stale.state).toBe('conflict');
  });

  it('print model (server and web): unknown is 未定/不明 never 0, withheld text hides restricted data, home address is absent', () => {
    const sm = serverPrintModel(trip, new Date(NOW));
    const text = sm.lines.map(l => l.text).join('\n');
    expect(text).toContain('費用: 不明');
    expect(text).not.toMatch(/費用: 0(\.0+)?( |$)/m);
    expect(text).toContain('時刻未定');
    expect(text).toContain('運賃・料金: 不明');
    for (const forbidden of ['転載不可の解説', '制限出典', '9:00-17:00', HOME_ADDRESS, '丸の内', '秘密のメモ']) expect(text).not.toContain(forbidden);
    expect(text).toContain('出発地');
    expect(sm.withheld.map(w => `${w.kind}:${w.id}`).sort()).toEqual(['leg:ge_l_res', 'photo:ge_restricted', 'place:ge_restricted']);
    expect(text).toContain('10:00〜12:00'); // Paris 10:00 CET

    const wm = webPrintModel(trip);
    const wtext = JSON.stringify(wm);
    for (const forbidden of ['転載不可の解説', '（架空）転載不可の庭', '制限出典']) expect(wtext).not.toContain(forbidden);
    expect(wm.cost.unknownCount).toBeGreaterThan(0);
    expect(wm.cost.perCurrency.join()).not.toMatch(/(^|\s)0(\s|$)/);
    expect(wm.days.flatMap(d => d.items).find(i => i.key === 'ge_a_untimed')!.time).toContain('未定');
  });
});

describe('I05 scenario 3: ICS and Maps links from the server trip', () => {
  const events = (ics: string) => ics.replace(/\r\n /g, '').split('BEGIN:VEVENT').slice(1).map(e => e.split('END:VEVENT')[0]!);
  const ev = (ics: string, id: string) => events(ics).find(e => e.includes(`UID:${id}.`));

  it('events carry TZID or UTC per item; the repeated Paris hour is UTC; untimed/withheld items are omitted per E03', () => {
    const r = tripToIcs(trip, { now: NOW });
    const ics = r.ics;
    expect(ev(ics, 'ge_a_orsay')).toContain('DTSTART;TZID=Europe/Paris:20261025T100000');
    expect(ev(ics, 'ge_a_orsay')).toContain('DTEND;TZID=Europe/Paris:20261025T120000');
    expect(ev(ics, 'ge_a_late')).toContain('DTSTART:20261025T013000Z');
    expect(ev(ics, 'ge_a_late')).toContain('DTEND;TZID=Europe/Paris:20261025T030000');
    expect(ev(ics, 'ge_a_ken')).toContain('DTSTART;TZID=Asia/Tokyo:20261101T100000');
    expect(ics).toContain('TZID:Europe/Paris');
    expect(ics).toContain('TZID:Asia/Tokyo');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ev(ics, 'ge_a_untimed')).toBeUndefined();
    expect(r.omitted).toEqual(expect.arrayContaining([
      { itemId: 'ge_a_untimed', reason: 'time_unknown' },
      { itemId: 'ge_l_home2', reason: 'time_unknown' },
      { itemId: 'ge_l_res', reason: 'not_exportable' },
    ]));
    expect(ev(ics, 'ge_l_res')).toBeUndefined();
    expect(r.eventCount).toBe(events(ics).length);
    expect(r.withheldPlaceIds).toContain('ge_restricted');
  });

  it('mayExport=false details, private notes and the home address never reach the ICS or the Maps URLs', () => {
    const { ics } = tripToIcs(trip, { now: NOW });
    const resEv = ev(ics, 'ge_a_res')!;
    expect(resEv).not.toContain('転載不可の庭（架空）');
    expect(resEv).not.toContain('GEO:');
    for (const forbidden of ['制限出典', '秘密のメモ', '丸の内', HOME_ADDRESS]) expect(ics).not.toContain(forbidden);
    expect(ev(ics, 'ge_l_home')).toContain('出発地');

    const links = tripMapsLinks(trip);
    const all = links.days.flatMap(d => [...d.places, ...d.routes]);
    expect(all.length).toBeGreaterThan(0);
    const allowed = new Set(trip.places.filter(p => p.provenance.mayExport && p.placeId !== 'ge_home').map(p => p.placeId));
    for (const l of all) {
      for (const id of l.placeIds) expect(allowed.has(id)).toBe(true);
      expect(l.url.startsWith('https://www.google.com/maps/')).toBe(true);
    }
    const joined = decodeURIComponent(all.map(l => l.url).join('\n'));
    for (const forbidden of ['丸の内', '山田邸', '転載不可の庭', '35.680000', '0.000000,0.000000']) expect(joined).not.toContain(forbidden);
    expect(links.withheldPlaceIds).toEqual(['ge_restricted']);
    expect(links.unknownPlaceIds).toEqual([]);
  });
});

describe('I05 scenario 4: image rights', () => {
  it('photos with mayExport=false or no author credit are in no output; a credited exportable one is only a credit line', () => {
    const wm = webPrintModel(trip);
    const items = wm.days.flatMap(d => d.items);
    const byKey = (k: string) => items.find(i => i.key === k)!;
    expect(byKey('ge_a_ken').photo).toEqual({ url: 'https://example.invalid/ken.jpg', credit: '撮影: 架空太郎（CC BY 4.0）' });
    expect(byKey('ge_a_res').photo).toBeNull();
    expect(byKey('ge_a_na').photo).toBeNull();
    expect(byKey('ge_a_na').photoPlaceholder).toBe(true);
    const all = JSON.stringify(wm);
    for (const forbidden of ['r.jpg', 'na.jpg', '制限花子']) expect(all).not.toContain(forbidden);

    const sm = serverPrintModel(trip, new Date(NOW));
    const text = sm.lines.map(l => l.text).join('\n');
    for (const forbidden of ['r.jpg', 'na.jpg', '制限花子', 'example.invalid']) expect(text).not.toContain(forbidden);
    expect(sm.withheld.some(w => w.kind === 'photo' && w.id === 'ge_restricted')).toBe(true);

    const { ics } = tripToIcs(trip, { now: NOW });
    for (const forbidden of ['r.jpg', 'na.jpg', 'ken.jpg', '制限花子', 'example.invalid', 'ATTACH']) expect(ics).not.toContain(forbidden);
  });
});
