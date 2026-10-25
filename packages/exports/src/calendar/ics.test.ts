import type { Activity, PlaceInfo, Trip, TripDay } from '@tkb/contracts';
import { domesticTrip, overseasTrip } from '@tkb/fixtures';
import { describe, expect, it } from 'vitest';
import { escapeText, foldLine, ICS_NOTICE, tripToIcs } from './ics.ts';

const NOW = '2026-10-24T00:00:00Z';

// ---- A small independent reader: resolves local times with the VTIMEZONE written in the file, not with Intl. ----

const unfold = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
const toMs = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
const offsetMin = (o: string) => (o[0] === '-' ? -1 : 1) * (+o.slice(1, 3) * 60 + +o.slice(3, 5));

function readIcs(ics: string) {
  const lines = unfold(ics);
  const zones = new Map<string, { localStart: number; to: number; from: number }[]>();
  const events: Record<string, string>[] = [];
  let tz: string | null = null;
  let obs: Record<string, string> | null = null;
  let ev: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT') (events.push(ev!), (ev = null));
    else if (/^BEGIN:(STANDARD|DAYLIGHT)$/.test(line)) obs = {};
    else if (/^END:(STANDARD|DAYLIGHT)$/.test(line)) {
      zones.get(tz!)!.push({ localStart: toMs(obs!.DTSTART!), from: offsetMin(obs!.TZOFFSETFROM!), to: offsetMin(obs!.TZOFFSETTO!) });
      obs = null;
    } else if (line.startsWith('TZID:')) zones.set((tz = line.slice(5)), []);
    else {
      const i = line.indexOf(':');
      const key = line.slice(0, i);
      if (obs) obs[key] = line.slice(i + 1);
      else if (ev) ev[key.split(';')[0]!] = line;
    }
  }
  /** RFC 5545: the observance in force is the latest one whose (local) DTSTART is not after the local time. */
  const resolve = (prop: string) => {
    const m = /^DT(?:START|END)(?:;TZID=([^:]+))?:(\d{8}T\d{6})(Z?)$/.exec(prop)!;
    if (m[3] === 'Z') return new Date(toMs(m[2]!)).toISOString().replace('.000Z', 'Z');
    const local = toMs(m[2]!);
    const list = zones.get(m[1]!)!;
    const active = [...list].reverse().find(o => o.localStart <= local) ?? list[0]!;
    return new Date(local - active.to * 60000).toISOString().replace('.000Z', 'Z');
  };
  const read: (Record<string, string> & { startUtc: string; endUtc: string })[] = events.map(e => Object.assign({}, e, { startUtc: resolve(e.DTSTART!), endUtc: resolve(e.DTEND!) }));
  return { lines, events: read };
}

const timedItems = (trip: Trip) =>
  trip.days
    .flatMap(d => d.items)
    .flatMap(i =>
      i.type === 'activity'
        ? i.start && i.end && i.status !== 'skipped'
          ? [{ id: i.activityId, start: i.start.utc, end: i.end.utc }]
          : []
        : i.departure && i.arrival
          ? [{ id: i.legId, start: i.departure.utc, end: i.arrival.utc }]
          : [],
    );

const place = (placeId: string, timeZone: string, extra: Partial<PlaceInfo> = {}): PlaceInfo => ({
  placeId,
  name: placeId,
  kind: 'spot',
  location: { lat: 1, lng: 2 },
  timeZone,
  openingHours: null,
  description: null,
  photo: null,
  dataStatus: 'verified',
  provenance: { source: 'test', fetchedAt: null, attribution: null, maySendToModel: false, mayStore: true, mayExport: true, retainUntil: null },
  ...extra,
});
const act = (id: string, timeZone: string, start: string, end: string, extra: Partial<Activity> = {}): Activity => ({
  type: 'activity',
  activityId: id,
  kind: 'visit',
  title: id,
  placeId: null,
  areaName: null,
  start: { utc: start, timeZone },
  end: { utc: end, timeZone },
  fixed: false,
  status: 'planned',
  cost: null,
  costStatus: 'unknown',
  privateNotes: null,
  ...extra,
});
const tripOf = (days: TripDay[], places: PlaceInfo[] = []) => ({ tripId: 't1', title: 'テスト', days, places, constraints: {} });
const flightLike = (legId: string, from: string, to: string, dep: string, arr: string) => ({
  type: 'leg' as const,
  legId,
  mode: 'transit' as const,
  fromPlaceId: from,
  toPlaceId: to,
  departure: { utc: dep, timeZone: 'Asia/Tokyo' },
  arrival: { utc: arr, timeZone: 'Asia/Tokyo' },
  durationSeconds: null,
  lineName: null,
  platform: null,
  transfers: null,
  fare: null,
  dataStatus: 'verified' as const,
  provenance: null,
});

describe('tripToIcs', () => {
  it('Japan: every timed item re-reads to the same instant; unknown times are omitted, not guessed', () => {
    const r = tripToIcs(domesticTrip, { now: NOW });
    const { events, lines } = readIcs(r.ics);
    expect(events.map(e => [e.UID!.slice(4).split('.')[0], e.startUtc, e.endUtc])).toEqual(timedItems(domesticTrip).map(i => [i.id, i.start, i.end]));
    expect(r.omitted).toEqual([
      { itemId: 'fx_act_hotel', reason: 'time_unknown' },
      { itemId: 'fx_act_station_end', reason: 'time_unknown' },
    ]);
    expect(r.eventCount).toBe(events.length);
    expect(lines).toContain('DTSTART;TZID=Asia/Tokyo:20261102T100000');
    expect(lines.filter(l => l.startsWith('TZOFFSETTO'))).toEqual(['TZOFFSETTO:+0900']);
    expect(r.ics).not.toContain('予約番号'); // privateNotes
    expect(r.ics).toContain('サンプルデータ（fixture）');
    expect(r).toMatchObject({ filename: 'fx_trip_kanazawa.ics', notice: ICS_NOTICE });
    expect(r.notice).toContain('自動登録は行いません');
  });

  it('Paris across the end of DST: VTIMEZONE carries the change and every item re-reads correctly', () => {
    const r = tripToIcs(overseasTrip, { now: NOW });
    const { events, lines } = readIcs(r.ics);
    expect(events.map(e => [e.startUtc, e.endUtc])).toEqual(timedItems(overseasTrip).map(i => [i.start, i.end]));
    const tz = lines.slice(lines.indexOf('TZID:Europe/Paris'), lines.indexOf('END:VTIMEZONE'));
    expect(tz).toEqual(expect.arrayContaining(['BEGIN:STANDARD', 'DTSTART:20261025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100']));
    expect(lines).toContain('DTSTART;TZID=Europe/Paris:20261024T100000'); // CEST
    expect(lines).toContain('DTSTART;TZID=Europe/Paris:20261025T100000'); // CET
  });

  it('writes the second pass through a repeated hour in UTC so it is not read as the first one', () => {
    const P = 'Europe/Paris';
    // 00:30Z and 01:30Z are both 02:30 local on 2026-10-25.
    const r = tripToIcs(tripOf([{ date: '2026-10-25', timeZone: P, items: [act('first', P, '2026-10-25T00:30:00Z', '2026-10-25T00:50:00Z'), act('second', P, '2026-10-25T01:30:00Z', '2026-10-25T01:50:00Z')] }]), { now: NOW });
    const { events, lines } = readIcs(r.ics);
    expect(lines).toContain('DTSTART;TZID=Europe/Paris:20261025T023000');
    expect(lines).toContain('DTSTART:20261025T013000Z');
    expect(events.map(e => e.startUtc)).toEqual(['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']);
  });

  it('keeps each end in its own zone (Tokyo to Paris flight) and handles a southern-hemisphere DST start', () => {
    const flight = {
      type: 'leg' as const,
      legId: 'flight',
      mode: 'transit' as const,
      fromPlaceId: 'hnd',
      toPlaceId: 'cdg',
      departure: { utc: '2026-10-23T13:00:00Z', timeZone: 'Asia/Tokyo' },
      arrival: { utc: '2026-10-24T04:30:00Z', timeZone: 'Europe/Paris' },
      durationSeconds: null,
      lineName: 'AF000（例）',
      platform: null,
      transfers: 0,
      fare: null,
      dataStatus: 'verified' as const,
      provenance: null,
    };
    const S = 'Australia/Sydney'; // DST starts 2026-10-04 02:00 -> 03:00
    const r = tripToIcs(
      tripOf(
        [
          { date: '2026-10-23', timeZone: 'Asia/Tokyo', items: [flight] },
          { date: '2026-10-04', timeZone: S, items: [act('syd', S, '2026-10-03T15:30:00Z', '2026-10-03T17:00:00Z')] },
        ],
        [place('hnd', 'Asia/Tokyo'), place('cdg', 'Europe/Paris')],
      ),
      { now: NOW },
    );
    const { events, lines } = readIcs(r.ics);
    expect(lines).toContain('DTSTART;TZID=Asia/Tokyo:20261023T220000');
    expect(lines).toContain('DTEND;TZID=Europe/Paris:20261024T063000');
    expect(lines).toContain('DTEND;TZID=Australia/Sydney:20261004T040000'); // after the jump to +11
    expect(events.map(e => [e.startUtc, e.endUtc])).toEqual([
      ['2026-10-23T13:00:00Z', '2026-10-24T04:30:00Z'],
      ['2026-10-03T15:30:00Z', '2026-10-03T17:00:00Z'],
    ]);
    expect(events[0]!.SUMMARY).toBe('SUMMARY:移動: hnd → cdg（AF000（例））');
    expect(events[0]!.DESCRIPTION).toContain('運賃: 未取得');
  });

  it('escapes text and folds long lines to 75 octets without splitting characters', () => {
    const title = 'A, B; C\\D\n二行目' + '長い題名'.repeat(30);
    const r = tripToIcs(tripOf([{ date: '2026-07-01', timeZone: 'Asia/Tokyo', items: [act('x', 'Asia/Tokyo', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { title })] }]), { now: NOW });
    for (const physical of r.ics.split('\r\n')) expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75);
    expect(r.ics.endsWith('\r\n')).toBe(true);
    const summary = readIcs(r.ics).events[0]!.SUMMARY!;
    expect(summary).toBe(`SUMMARY:${escapeText(title)}`);
    expect(summary.startsWith('SUMMARY:A\\, B\\; C\\\\D\\n二行目')).toBe(true);
    expect(foldLine('x'.repeat(75))).toBe('x'.repeat(75));
    expect(foldLine('x'.repeat(76))).toBe(`${'x'.repeat(75)}\r\n x`);
  });

  it('withholds place details the provider does not allow to export, and leaves out skipped activities', () => {
    const T = 'Asia/Tokyo';
    const secret = place('secret', T, { name: '非公開の地点', provenance: { ...place('s', T).provenance, mayExport: false } });
    const r = tripToIcs(
      tripOf(
        [
          {
            date: '2026-07-01',
            timeZone: T,
            items: [
              act('v', T, '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { placeId: 'secret' }),
              act('gone', T, '2026-07-01T03:00:00Z', '2026-07-01T04:00:00Z', { status: 'skipped' }),
              act('done', T, '2026-07-01T05:00:00Z', '2026-07-01T06:00:00Z', { status: 'completed', placeId: 'ok' }),
            ],
          },
        ],
        [secret, place('ok', T)],
      ),
      { now: NOW },
    );
    const { events } = readIcs(r.ics);
    expect(events.map(e => e.UID)).toEqual(['UID:v.t1@tkb-2627', 'UID:done.t1@tkb-2627']);
    expect(r.ics).not.toContain('非公開の地点');
    expect(events[0]).not.toHaveProperty('GEO');
    expect(events[1]).toMatchObject({ LOCATION: 'LOCATION:ok', GEO: 'GEO:1.000000;2.000000' });
    expect(events[1]!.DESCRIPTION).toContain('訪問済み');
    expect(r.withheldPlaceIds).toEqual(['secret']);
  });

  it('leaves out a leg whose provider does not allow export, since its times come from that provider', () => {
    const trip = structuredClone(overseasTrip);
    for (const item of trip.days.flatMap(d => d.items)) if (item.type === 'leg' && item.provenance) item.provenance.mayExport = false;
    const r = tripToIcs(trip, { now: NOW });
    expect(r.omitted).toEqual([
      { itemId: 'fx_leg_p1', reason: 'not_exportable' },
      { itemId: 'fx_leg_p2', reason: 'not_exportable' },
    ]);
    expect(r.ics).not.toContain('20261024T131500');
    expect(r.ics).not.toContain('Métro');
  });

  it('drops control characters, writes GEO without exponents, a zero-length item as DURATION, and the revision as SEQUENCE', () => {
    const T = 'Asia/Tokyo';
    const r = tripToIcs(
      {
        ...tripOf(
          [{ date: '2026-07-01', timeZone: T, items: [act('z', T, '2026-07-01T01:00:00Z', '2026-07-01T01:00:00Z', { title: 'a\u0007b\u0000c\td', placeId: 'tiny' })] }],
          [place('tiny', T, { location: { lat: 1e-7, lng: -1e-7 } })],
        ),
        revision: 4,
      },
      { now: NOW },
    );
    const lines = unfold(r.ics);
    expect(lines).toEqual(expect.arrayContaining(['SUMMARY:abc\td', 'GEO:0.000000;-0.000000', 'DURATION:PT0S', 'SEQUENCE:3']));
    expect(lines.some(l => l.startsWith('DTEND'))).toBe(false);
  });

  it('writes the departure/return place (often home) only as 出発地/到着地', () => {
    const T = 'Asia/Tokyo';
    const home = place('home', T, { name: '山田家（自宅）' });
    const trip = {
      ...tripOf(
        [
          {
            date: '2026-07-01',
            timeZone: T,
            items: [
              { ...flightLike('go', 'home', 'ok', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z') },
              act('v', T, '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { placeId: 'ok' }),
              { ...flightLike('back', 'ok', 'home', '2026-07-01T09:00:00Z', '2026-07-01T10:00:00Z') },
              act('h', T, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', { placeId: 'home', kind: 'lodging', areaName: '三軒茶屋2丁目' }),
            ],
          },
        ],
        [home, place('ok', T)],
      ),
      constraints: { ...domesticTrip.constraints, departure: { placeId: 'home', label: null, time: null }, return: { placeId: 'home', label: null, time: null } },
    };
    const r = tripToIcs(trip, { now: NOW });
    expect(r.ics).not.toContain('山田家');
    const { events } = readIcs(r.ics);
    expect(events[0]!.SUMMARY).toBe('SUMMARY:移動: 出発地 → ok（公共交通）');
    expect(events[2]!.SUMMARY).toBe('SUMMARY:移動: ok → 到着地（公共交通）');
    // No area name either: it could pinpoint home.
    expect(events[3]).toMatchObject({ LOCATION: 'LOCATION:出発地' });
    expect(events[3]).not.toHaveProperty('GEO');
    expect(r.ics).not.toContain('三軒茶屋');
  });

  it('omits an item that ends before it starts instead of shortening it', () => {
    const T = 'Asia/Tokyo';
    const r = tripToIcs(
      tripOf([{ date: '2026-07-01', timeZone: T, items: [act('bad', T, '2026-07-01T02:00:00Z', '2026-07-01T01:00:00Z'), flightLike('badleg', 'a', 'b', '2026-07-01T05:00:00Z', '2026-07-01T04:00:00Z')] }]),
      { now: NOW },
    );
    expect(r.omitted).toEqual([
      { itemId: 'bad', reason: 'invalid_time' },
      { itemId: 'badleg', reason: 'invalid_time' },
    ]);
    expect(r.eventCount).toBe(0);
  });

  it('credits the provider attribution of exported places and legs, escaped', () => {
    const r = tripToIcs(domesticTrip, { now: NOW });
    const events = readIcs(r.ics).events;
    expect(events.find(e => e.UID!.startsWith('UID:fx_act_kenrokuen'))!.DESCRIPTION).toContain('出典: tkb_2627 fixture');
    expect(events.find(e => e.UID!.startsWith('UID:fx_leg_k1'))!.DESCRIPTION).toContain('出典: tkb_2627 fixture');

    const trip = structuredClone(domesticTrip);
    trip.places = trip.places.map(p => (p.placeId === 'fx_kenrokuen' ? { ...p, provenance: { ...p.provenance, attribution: 'Google, ©Map; x' } } : p));
    expect(tripToIcs(trip, { now: NOW }).ics).toContain('出典: Google\\, ©Map\\; x');
  });

  it('is reproducible for the same input and export time', () => {
    expect(tripToIcs(overseasTrip, { now: NOW }).ics).toBe(tripToIcs(structuredClone(overseasTrip), { now: NOW }).ics);
  });
});
