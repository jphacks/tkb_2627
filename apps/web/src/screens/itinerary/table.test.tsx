/**
 * U04 rework (Issue #32 review): the itinerary is an n-row x 2-column table, a leg is two thin rows with one time each,
 * a stay opens one level (nested activities by time), clicking shows details, the map has arrows and no list, rows can
 * be reordered (drag / keyboard) as K10 move operations, and the result shows under the U03 form.
 */
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Activity, Trip, TripOperation } from '@tkb/contracts';
import { PlanBatch, Trip as TripSchema } from '@tkb/contracts';
import { createSamplePlanBatch, domesticTrip } from '@tkb/fixtures';
import { applyOperations as applyServer, nestingError } from '../../../../server/src/trips/operations.ts';
import { applyOperations as applyClient, reorderOps } from '../edit/ops.ts';
import { CandidatePreview, candidateAsTrip } from '../generate/CandidatePreview.tsx';
import { ItineraryView } from './ItineraryScreen.tsx';
import { StaticMap, projectPoints, segmentArrows } from './MapPanel.tsx';
import { mapPoints } from './model.ts';
import {
  blockOf, formatHm, hoverTarget, insertBeforeKey, keyboardTarget, legDetails, planMoves, reorderedOrder, stayDetails, stayRange, tableRows,
  type LegRow, type StayRow,
} from './table.ts';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const day1 = domesticTrip.days[0]!;
const day2 = domesticTrip.days[1]!;
const SHOWN_AS_ZERO = /[¥￥€]\s?0(?![\d,.])|(?<![\d,.:])0(円|分)/;

describe('the sample trip (H)', () => {
  it('is a valid dense 2-day Kanazawa trip with nested activities, valid nesting and fixture marking', () => {
    expect(TripSchema.safeParse(domesticTrip).success).toBe(true);
    expect(nestingError(domesticTrip.days)).toBeNull();
    expect(domesticTrip.title).toContain('fixture');
    expect(domesticTrip.days).toHaveLength(2);
    const titles1 = tableRows(day1, domesticTrip.places).flatMap(r => (r.kind === 'stay' ? [r.item.title] : []));
    expect(titles1).toEqual(['金沢駅（出発）', '近江町市場エリア', '金沢城公園', '兼六園を散策', '金沢21世紀美術館', '香林坊で夕食', '香林坊バス停（乗車）', 'ホテルにチェックイン']);
    const titles2 = tableRows(day2, domesticTrip.places).flatMap(r => (r.kind === 'stay' ? [r.item.title] : []));
    expect(titles2).toEqual(['ひがし茶屋街', '主計町茶屋街を歩く', '尾山神社', '香林坊で昼食', 'にし茶屋街を見学', '妙立寺', '長町武家屋敷跡', '金沢駅（到着）']);
  });

  it('has a leg between every pair of consecutive top-level stays, and no meal right after a meal at the same place', () => {
    for (const day of domesticTrip.days) {
      const rows = tableRows(day, domesticTrip.places);
      rows.forEach((r, i) => {
        if (r.kind === 'stay' && rows[i + 1]) expect(rows[i + 1]!.kind, `after ${r.item.title}`).toBe('leg');
        if (r.kind === 'leg') expect(['stay', 'stop']).toContain(rows[i + 1]?.kind);
      });
      const meals = day.items.filter((it): it is Activity => it.type === 'activity' && it.kind === 'meal');
      meals.forEach((m, i) => { const n = meals[i + 1]; if (n) expect(n.placeId).not.toBe(m.placeId); });
    }
  });

  it('times are consistent: each stay starts after the previous leg arrives; children sit inside their parent', () => {
    for (const day of domesticTrip.days) {
      const t = (z: { utc: string } | null) => (z ? Date.parse(z.utc) : null);
      let last: number | null = null;
      for (const it of day.items) {
        if (it.type === 'activity' && it.parentActivityId) {
          const p = day.items.find(x => x.type === 'activity' && x.activityId === it.parentActivityId) as Activity;
          expect(t(it.start)!).toBeGreaterThanOrEqual(t(p.start)!);
          expect(t(it.end)!).toBeLessThanOrEqual(t(p.end)!);
          continue;
        }
        const start = it.type === 'activity' ? t(it.start) : t(it.departure);
        const end = it.type === 'activity' ? t(it.end) : t(it.arrival);
        if (start !== null && last !== null) expect(start).toBeGreaterThanOrEqual(last);
        if (end !== null) last = end;
        else if (start !== null) last = start;
      }
    }
  });
});

describe('B: table with one place per row and legs as two rows (R3)', () => {
  it('a stay row shows its time as 「9:25〜12:30」 and children are not top-level rows', () => {
    const rows = tableRows(day1, domesticTrip.places);
    const omicho = rows.find(r => r.kind === 'stay' && r.key === 'fx_act_omicho') as StayRow;
    expect(omicho.range).toBe('9:30〜12:30');
    expect(omicho.children.map(c => [c.item.title, c.range])).toEqual([
      ['市場を散策（買い物・見学）', '9:30〜11:30'],
      ['寿司店Aで海鮮丼の昼食（予約済み）', '11:30〜12:15'],
    ]);
    expect(rows.some(r => r.key === 'fx_act_lunch')).toBe(false);
  });

  it('a leg is a start row and an end row with one arrow through both and no times (UI review on #32), not one "A → B" card', () => {
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(html).toContain('<table class="it-table"');
    expect(html).toContain('<th scope="col" class="it-col-time">時刻</th><th scope="col">内容</th>');
    const start = /<tr class="it-conn it-conn-start" data-leg-key="fx_leg_k2"[^>]*>(.*?)<\/tr>/.exec(html)?.[1] ?? '';
    const end = /<tr class="it-conn it-conn-end" data-leg-key="fx_leg_k2"[^>]*>(.*?)<\/tr>/.exec(html)?.[1] ?? '';
    expect(start).toContain('<td class="it-conncell" rowSpan="2"><span aria-hidden="true" class="it-arrowline"></span>');
    expect(text(start)).toContain('徒歩・15分');
    // The names are the rows above and below: read out, not repeated on screen (UI review on #33).
    expect(text(start)).not.toContain('近江町市場から');
    expect(start).toContain('aria-label="近江町市場から金沢城公園への移動：徒歩・15分"');
    expect(text(start)).not.toContain('→');
    expect(text(end)).toBe('');
    expect(text(start)).not.toContain('12:45');
    expect(text(end)).not.toContain('12:30');
    expect(html).not.toContain('近江町市場 → 金沢城公園');
  });

  it('an unknown time is 未取得 (never 0 or a guess), including a leg without arrival', () => {
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    const leg = tableRows(day1, domesticTrip.places).find(r => r.kind === 'leg' && r.key === 'fx_leg_k1') as LegRow;
    const d = legDetails(leg, '2026-11-01');
    expect(d.find(l => l.label === '到着')).toMatchObject({ value: '未取得', unknown: true });
    expect(html).not.toMatch(SHOWN_AS_ZERO);
    expect(stayRange(null, null, '2026-11-01')).toBe('未取得〜未取得');
    expect(formatHm({ utc: '2026-11-01T16:00:00Z', timeZone: 'Asia/Tokyo' }, '2026-11-01')).toBe('11/2 1:00');
  });
});

describe('UI review on #32 (second round)', () => {
  it('a station shows one time (leave / arrive), other stays a range', () => {
    const rows = tableRows(day1, domesticTrip.places);
    const range = (k: string) => (rows.find(r => r.kind === 'stay' && r.key === k) as StayRow).range;
    expect(range('fx_act_station')).toBe('9:00');
    expect(range('fx_act_castle')).toBe('12:45〜14:00');
  });
  it('nested activities show only their time and name; undo / re-timing sit under the table; no hint text on screen', () => {
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} editor={{ kind: 'local' }} initialExpanded={['fx_act_omicho']} />);
    const child = /<tr class="it-child">(.*?)<\/tr>/.exec(html)?.[1] ?? '';
    expect(child).toContain('市場を散策');
    expect(child).not.toContain('<dl');
    expect(html.indexOf('>元に戻す</button>')).toBeGreaterThan(html.indexOf('aria-label="行程表"'));
    expect(html).toContain('<p class="u1-sr" id="it-reorder-help">');
    expect(html).not.toContain('it-hint');
  });
});

describe('C: a stay opens one level with its nested activities by time (R2)', () => {
  it('closed by default: nested activities are not shown; opened: they appear inside the parent, in time order', () => {
    const closed = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('海鮮丼の昼食');
    const open = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} initialExpanded={['fx_act_omicho']} />);
    expect(open).toContain('aria-expanded="true"');
    expect(open.indexOf('市場を散策')).toBeGreaterThan(-1);
    expect(open.indexOf('市場を散策')).toBeLessThan(open.indexOf('海鮮丼の昼食'));
    expect(text(open)).toContain('11:30〜12:15');
  });

  it('a child with unknown times keeps 未取得 inside the parent', () => {
    const trip = structuredClone(domesticTrip);
    const kid = trip.days[0]!.items.find(i => i.type === 'activity' && i.activityId === 'fx_act_omicho_walk') as Activity;
    kid.start = null;
    kid.end = null;
    const html = render(<ItineraryView trip={trip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} initialExpanded={['fx_act_omicho']} />);
    expect(html).toContain('<span class="u1-unknown">未取得</span>〜<span class="u1-unknown">未取得</span>');
  });

  it('the map numbers top-level stays only: nested activities are not points', () => {
    const points = mapPoints(day1, domesticTrip.places);
    expect(points.map(p => p.placeId)).toEqual([
      'fx_kanazawa_station', 'fx_omicho', 'fx_kanazawa_castle', 'fx_kenrokuen', 'fx_21c_museum', 'fx_dinner', 'fx_korinbo_stop', 'fx_hotel',
    ]);
    expect(points.some(p => p.placeId === 'fx_sushi')).toBe(false);
    // 2 and 9 are the stops the buses get off at (derived stop rows, no map marker).
    expect(points.map(p => p.number)).toEqual([1, 3, 4, 5, 6, 7, 8, 10]);
  });
});

describe('D: clicking shows details (description, time, cost, source)', () => {
  it('stay details are compact: place, hours and cost only (UI review on #32: no time/kind again, no description or sources)', () => {
    const row = tableRows(day1, domesticTrip.places).find(r => r.kind === 'stay' && r.key === 'fx_act_kenrokuen') as StayRow;
    const d = Object.fromEntries(stayDetails(row).map(l => [l.label, l.value]));
    expect(Object.keys(d)).toEqual(['場所', '営業時間', '費用']);
    expect(d['営業時間']).toContain('7:00-18:00');
    expect(d['費用']).toContain('320');
  });

  it('unknown hours / cost are 未取得, not blank and not 0', () => {
    const row = tableRows(day1, domesticTrip.places).find(r => r.kind === 'stay' && r.key === 'fx_act_museum') as StayRow;
    const lines = stayDetails(row);
    for (const label of ['営業時間', '費用']) {
      const l = lines.find(x => x.label === label)!;
      expect(l.value).toBe('未取得');
      expect(l.unknown).toBe(true);
    }
  });

  it('a leg shows departure, arrival, duration, fare and source when opened', () => {
    const leg = tableRows(day1, domesticTrip.places).find(r => r.kind === 'leg' && r.key === 'fx_leg_k6') as LegRow;
    const d = Object.fromEntries(legDetails(leg, '2026-11-01').map(l => [l.label, l.value]));
    expect(d['出発']).toBe('19:10');
    expect(d['到着']).toBe('19:25');
    expect(d['運賃']).toContain('210');
    expect(d['路線']).toBe('（fixture）路線バス');
  });

  it('a selected row (also selected from a map marker) is opened with its details in the rendered table', () => {
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null}
      initialSelection={{ kind: 'place', placeId: 'fx_omicho' }} initialExpanded={['fx_act_omicho']} />);
    expect(html).toContain('class="it-stay it-on"');
    expect(html).toContain('id="it-d-fx_act_omicho"');
    expect(html).toContain('<dt>費用</dt>');
  });
});

describe('E/F: map without a list, with direction arrows', () => {
  it('the fallback map is an SVG with points and arrows and no numbered place list below it', () => {
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(html).toContain('<svg');
    expect(html).not.toContain('aria-label="地図上の地点（訪問順）"');
    expect(html).not.toContain('it-points');
    expect((html.match(/data-testid="map-arrow"/g) ?? []).length).toBe(7);
    expect((html.match(/role="button" tabindex="0"/g) ?? []).length).toBe(8);
  });

  it('arrows point from each point to the next (angle follows the direction of travel)', () => {
    const pts = projectPoints([
      { placeId: 'a', number: 1, name: 'A', lat: 36.0, lng: 136.0 },
      { placeId: 'b', number: 2, name: 'B', lat: 36.0, lng: 136.01 },
      { placeId: 'c', number: 3, name: 'C', lat: 36.01, lng: 136.01 },
    ]);
    const arrows = segmentArrows(pts);
    expect(arrows.map(a => [a.from, a.to])).toEqual([[1, 2], [2, 3]]);
    expect(arrows[0]!.angle).toBeCloseTo(0, 0); // east
    expect(arrows[1]!.angle).toBeCloseTo(-90, 0); // north (SVG y grows downwards)
    expect(pts.every(p => p.x >= 0 && p.x <= 320 && p.y >= 0 && p.y <= 220)).toBe(true);
  });

  it('a single point has no arrows; no points says so', () => {
    expect(segmentArrows(projectPoints([{ placeId: 'a', number: 1, name: 'A', lat: 1, lng: 1 }]))).toEqual([]);
    expect(render(<StaticMap points={[]} highlighted={new Set()} onSelectPlace={noop} reason="地図キー未設定" />)).toContain('位置の分かる地点がありません');
  });

  it('the Google map draws arrowed polylines (SymbolPath.FORWARD_CLOSED_ARROW repeated)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./MapPanel.tsx', import.meta.url), 'utf8');
    expect(src).toContain('icons: [{ icon: { path: 1');
    expect(src).toContain("repeat: '90px'");
    expect(src).not.toContain('PointList');
  });
});

describe('G: drag-and-drop reordering as K10 move operations (R1)', () => {
  const ids = (d: typeof day1) => d.items.map(i => (i.type === 'activity' ? i.activityId : i.legId));
  const finalIds = (trip: Trip) => ids(trip.days[0]!);

  it('moving a stay moves its children with it, in both server and client semantics', () => {
    const order = ids(day1);
    const block = blockOf(day1, 'fx_act_omicho');
    expect(block).toEqual(['fx_act_omicho', 'fx_act_omicho_walk', 'fx_act_lunch']);
    const ops = planMoves(order, block, 'fx_act_museum', 0);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every(o => o.op === 'move' && o.toDayIndex === 0)).toBe(true);
    const target = reorderedOrder(order, block, 'fx_act_museum');
    const server = applyServer(domesticTrip, ops);
    expect(server.ok).toBe(true);
    if (server.ok) expect(finalIds(server.trip)).toEqual(target);
    const client = applyClient(domesticTrip, ops);
    expect(client.ok && finalIds(client.trip)).toEqual(target);
    // the children stay right behind their parent
    const at = target.indexOf('fx_act_omicho');
    expect(target.slice(at, at + 3)).toEqual(block);
  });

  it('works for every stay and every target (forward, backward, to the end), and the result stays valid nesting', () => {
    const order = ids(day1);
    const stays = tableRows(day1, domesticTrip.places).flatMap(r => (r.kind === 'stay' ? [r.key] : []));
    for (const dragged of stays) {
      for (const before of [...stays.filter(s => s !== dragged), null]) {
        const block = blockOf(day1, dragged);
        const ops = planMoves(order, block, before, 0);
        const target = reorderedOrder(order, block, before);
        const server = applyServer(domesticTrip, ops);
        expect(server.ok, `${dragged} before ${before}`).toBe(true);
        if (server.ok) expect(finalIds(server.trip), `${dragged} before ${before}`).toEqual(target);
        expect(ops.length).toBeLessThanOrEqual(50);
      }
    }
  });

  it('dropping where it already is makes no operation', () => {
    const order = ids(day1);
    expect(planMoves(order, blockOf(day1, 'fx_act_castle'), 'fx_leg_k3', 0)).toEqual([]);
  });

  it('pointer drop target: upper half inserts before the row, lower half before the next stay; no-ops are ignored', () => {
    const keys = ['a', 'b', 'c', 'd'];
    expect(insertBeforeKey(keys, 'd', 'b', false)).toBe('b');
    expect(insertBeforeKey(keys, 'a', 'c', true)).toBe('d');
    expect(insertBeforeKey(keys, 'a', 'd', true)).toBeNull();
    expect(insertBeforeKey(keys, 'b', 'a', true)).toBeUndefined(); // right where it is
    expect(insertBeforeKey(keys, 'b', 'b', false)).toBeUndefined();
    expect(insertBeforeKey(keys, 'x', 'b', false)).toBeUndefined();
  });

  it('keyboard alternative: one stay up or down, nothing past the ends', () => {
    const keys = ['a', 'b', 'c'];
    expect(keyboardTarget(keys, 'b', -1)).toBe('a');
    expect(keyboardTarget(keys, 'a', -1)).toBeUndefined();
    expect(keyboardTarget(keys, 'a', 1)).toBe('c');
    expect(keyboardTarget(keys, 'b', 1)).toBeNull();
    expect(keyboardTarget(keys, 'c', 1)).toBeUndefined();
  });

  it('a reorder leaves the old legs mismatched: they are flagged 要再計算 instead of silently showing wrong travel', () => {
    const ops = planMoves(ids(day1), blockOf(day1, 'fx_act_castle'), 'fx_act_omicho', 0);
    const moved = applyClient(domesticTrip, ops);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const rows = tableRows(moved.trip.days[0]!, moved.trip.places);
    expect(rows.some(r => r.kind === 'leg' && r.stale)).toBe(true);
    const html = render(<ItineraryView trip={moved.trip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(html).toContain('要再計算');
  });

  it('editable tables have a handle per stay (with an accessible name) and a hint; read-only tables have none', () => {
    const rw = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} editor={{ kind: 'local' }} />);
    expect((rw.match(/class="it-handle"/g) ?? []).length).toBe(10); // 8 stays + 2 bus stops
    expect(rw).toContain('aria-label="「兼六園を散策」を並べ替える"');
    expect(rw).not.toContain('上へ');
    expect(rw).not.toContain('下へ');
    const ro = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(ro).not.toContain('it-handle');
  });

  it('the handle is the far-left column, before the time (UI review on #33); read-only tables keep two columns', () => {
    const rw = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} editor={{ kind: 'local' }} />);
    expect(rw).toContain('<thead><tr><th scope="col" class="it-col-handle"><span class="u1-sr">並べ替え</span></th><th scope="col" class="it-col-time">時刻</th>');
    const stay = /<tr[^>]*data-stay-key="fx_act_kenrokuen"[^>]*>(.*?)<\/tr>/.exec(rw)?.[1] ?? '';
    expect(stay.indexOf('it-handle')).toBeGreaterThan(-1);
    expect(stay.indexOf('it-handle')).toBeLessThan(stay.indexOf('it-time'));
    const ro = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(ro).not.toContain('it-col-handle');
  });

  it('editable tables offer undo (disabled until something changed) and re-timing; read-only tables do not', () => {
    const rw = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} editor={{ kind: 'local' }} />);
    expect(rw).toMatch(/<button[^>]*disabled=""[^>]*>元に戻す<\/button>/);
    expect(rw).toContain('>時刻を再計算</button>');
    const ro = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(ro).not.toContain('元に戻す');
    expect(ro).not.toContain('時刻を再計算');
  });

  it('a stay row does not repeat an unknown cost (it stays in the details)', () => {
    const html = render(<ItineraryView trip={domesticTrip} source="mock" dayIndex={0} onSelectDay={noop} mapsKey={null} />);
    expect(text(html)).not.toContain('費用 未取得');
  });
});

describe('A: the result is shown under the U03 form on the planning page', () => {
  const batch = PlanBatch.parse(createSamplePlanBatch());
  it('a candidate becomes an unsaved trip with its own days, places and warnings', () => {
    const trip = candidateAsTrip(batch, batch.candidates[0]!, domesticTrip.constraints);
    expect(TripSchema.safeParse(trip).success).toBe(true);
    expect(trip.days).toEqual(batch.candidates[0]!.days);
    expect(trip.warnings).toEqual(batch.candidates[0]!.warnings);
    expect(trip.tripId.startsWith('preview_')).toBe(true);
  });

  it('CandidatePreview renders the table and map of the first candidate and says it is not saved', () => {
    const html = render(<CandidatePreview batch={batch} constraints={domesticTrip.constraints} mapsKey={null} />);
    expect(html).toContain('生成された旅程：地図と行程表');
    expect(html).toContain('<table class="it-table"');
    expect(html).toContain('data-testid="map-fallback"');
    expect(html).toContain('まだ保存していません');
    expect(html).toContain('候補1');
    expect(html).toContain('aria-label="表示する候補"');
    expect(html).toContain('class="it-handle"');
  });

  it('GenerateApp keeps the condition form on the page and renders the result section after it', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../generate/GenerateApp.tsx', import.meta.url), 'utf8');
    const form = src.indexOf('<ConditionsScreen');
    const preview = src.indexOf('<CandidatePreview');
    expect(form).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(form);
    expect(src).not.toContain("step.name === 'conditions' && (");
  });
});

describe('server-mode saving (G): K10 PATCH with expectedRevision; a 409 never overwrites', () => {
  it('the planned operations are a valid K10 body', async () => {
    const { TripPatchRequest } = await import('@tkb/contracts');
    const ops: TripOperation[] = planMoves(day1.items.map(i => (i.type === 'activity' ? i.activityId : i.legId)), blockOf(day1, 'fx_act_museum'), 'fx_act_castle', 0);
    expect(TripPatchRequest.safeParse({ expectedRevision: domesticTrip.revision, operations: ops }).success).toBe(true);
  });
});

describe('UI review on #34: drag handle size and a stable layout while dragging', () => {
  const css = readFileSync(new URL('./itinerary.css', import.meta.url), 'utf8');
  const rule = (sel: string): string => {
    const start = css.indexOf(`\n${sel} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  };
  it('the dashed handle fills its cell, which is as tall as the row (and as the blue left bar)', () => {
    expect(rule('.it-handlecell')).toContain('position: relative');
    expect(rule('.it-handlecell')).toContain('padding: 0');
    expect(rule('.it-handle')).toMatch(/position: absolute;\s*inset: 0/);
    expect(rule('.it-handle')).toContain('border: 1px dashed');
    expect(css).toMatch(/\.it-stay > :first-child, \.it-stoprow > :first-child \{ border-left: 4px solid/);
  });
  it('the 「移動中」 note does not push the table down while a stay is dragged (it made adjacent swaps impossible)', () => {
    expect(rule('.it-dragnote')).toContain('position: fixed');
  });
  it('swapping with the next stay (dragging down) is planned and applied like dragging up', () => {
    const day = domesticTrip.days[0]!;
    const stays = tableRows(day, domesticTrip.places).flatMap(r => (r.kind === 'stay' ? [r.key] : []));
    const i = stays.indexOf('fx_act_castle');
    // Dragging the castle over the lower half of the next stay (兼六園): insert before the one after it.
    const before = hoverTarget(stays, stays, 'fx_act_castle', stays[i + 1]!, true);
    expect(before).toBe(stays[i + 2]);
    const r = applyClient(domesticTrip, reorderOps(domesticTrip, 0, 'fx_act_castle', before as string));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const order = tableRows(r.trip.days[0]!, r.trip.places).flatMap(x => (x.kind === 'stay' ? [x.key] : []));
      expect(order.indexOf('fx_act_kenrokuen')).toBe(i);
      expect(order.indexOf('fx_act_castle')).toBe(i + 1);
    }
  });
});
