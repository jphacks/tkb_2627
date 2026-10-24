import type { Activity, ExportWithheld, Money, PlaceInfo, TravelLeg, Trip } from '@tkb/contracts';

/**
 * E02: the fixed print layout of a trip as plain lines (K18 format=pdf). Pure and synchronous, so the content rules
 * are tested without rendering a PDF:
 * - local times are shown in each item's own IANA zone (R07);
 * - unknown values are written as 未定/不明, never as 0 (docs/08);
 * - places, legs and photos whose provider does not allow export (`mayExport=false`) are left out and listed under
 *   「出力できない項目」 (K18 転載不可の素材, E03);
 * - the departure/return places (often home) are written only as 出発地/到着地;
 * - private notes are never written; no map image and no remote photo is ever drawn (no URL is loaded).
 */

export type LineStyle = 'title' | 'heading' | 'item' | 'detail' | 'note';
export interface PrintLine {
  text: string;
  style: LineStyle;
}
export interface PrintWithheld extends ExportWithheld {
  label: string;
}
export interface PrintModel {
  lines: PrintLine[];
  withheld: PrintWithheld[];
  /** Activities and legs written to the file. */
  printedItems: number;
  /** True when the trip has items but every one of them is withheld (K18: 422). */
  nothingExportable: boolean;
  filename: string;
}

const UNKNOWN = '不明';
const KIND_LABEL: Record<Activity['kind'], string> = { visit: '訪問', meal: '食事', free_walk: '自由散策', lodging: '宿泊', custom: '予定' };
const MODE_LABEL: Record<TravelLeg['mode'], string> = { transit: '公共交通', car: '車', walk: '徒歩' };
const TRANSPORT_LABEL: Record<Trip['constraints']['transportMode'], string> = { transit: '公共交通', car: '車' };
const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];
const FIXTURE_NOTE = 'サンプルデータ（fixture）を含みます。実在の時刻・料金・営業時間ではありません。';

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Local date (YYYY-MM-DD) and time (HH:mm) of a UTC instant in an IANA zone. */
export function localParts(utc: string, timeZone: string): { date: string; time: string } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(Date.parse(utc)))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Money in major units with its ISO code. null is written as 不明, never as 0. */
export function formatMoney(m: Money | null): string {
  if (m === null) return UNKNOWN;
  const digits = fractionDigits(m.currency);
  const sign = m.amountMinor < 0 ? '-' : '';
  const abs = Math.abs(m.amountMinor);
  const whole = Math.floor(abs / 10 ** digits).toLocaleString('en-US');
  const frac = digits === 0 ? '' : `.${String(abs % 10 ** digits).padStart(digits, '0')}`;
  return `${sign}${whole}${frac} ${m.currency}`;
}

function dayHeading(date: string, timeZone: string, mode: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = WEEKDAY[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()];
  return `${m}月${d}日（${wd}） ・ ${timeZone} ・ 交通: ${mode}`;
}

/** "HH:mm" in the item's zone; prefixed with M/D when the local date is not the day's date; zone shown when different. */
function clock(t: { utc: string; timeZone: string } | null, dayDate: string, dayZone: string): string {
  if (t === null) return '未定';
  const { date, time } = localParts(t.utc, t.timeZone);
  const [, m, d] = date.split('-').map(Number);
  const prefix = date === dayDate ? '' : `${m}/${d} `;
  const zone = t.timeZone === dayZone ? '' : ` (${t.timeZone})`;
  return `${prefix}${time}${zone}`;
}

function span(start: { utc: string; timeZone: string } | null, end: { utc: string; timeZone: string } | null, dayDate: string, dayZone: string): string {
  if (start === null && end === null) return '時刻未定';
  return `${clock(start, dayDate, dayZone)}〜${clock(end, dayDate, dayZone)}`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return UNKNOWN;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `約${minutes}分`;
  return `約${Math.floor(minutes / 60)}時間${minutes % 60 ? `${minutes % 60}分` : ''}`;
}

export function buildPrintModel(
  trip: Pick<Trip, 'tripId' | 'title' | 'revision' | 'days' | 'places'> & { constraints: Trip['constraints'] },
  now: Date,
): PrintModel {
  const places = new Map(trip.places.map((p) => [p.placeId, p]));
  const dep = trip.constraints.departure?.placeId ?? null;
  const ret = trip.constraints.return?.placeId ?? null;
  const isPrivate = (id: string | null) => id !== null && (id === dep || id === ret);
  const privateLabel = (id: string | null) => (id === dep ? '出発地' : '到着地');

  const withheld: PrintWithheld[] = [];
  const withheldKeys = new Set<string>();
  const withhold = (kind: PrintWithheld['kind'], id: string, label: string) => {
    const key = `${kind}:${id}`;
    if (withheldKeys.has(key)) return;
    withheldKeys.add(key);
    withheld.push({ kind, id, label });
  };
  const attributions = new Set<string>();
  let fixture = false;
  let photosNotDrawn = 0;

  /** The place if it may be written; records it as withheld otherwise. */
  const exportable = (id: string | null, owner: string): PlaceInfo | undefined => {
    if (id === null || isPrivate(id)) return undefined;
    const place = places.get(id);
    if (!place) return undefined;
    if (!place.provenance.mayExport) {
      withhold('place', place.placeId, `「${owner}」の場所の詳細`);
      if (place.photo) withhold('photo', place.placeId, `「${owner}」の写真`);
      return undefined;
    }
    return place;
  };
  const placeName = (id: string | null, owner: string): string => {
    if (id !== null && isPrivate(id)) return privateLabel(id);
    const p = exportable(id, owner);
    if (p) return p.name;
    return id !== null && places.has(id) ? '（出力できない場所）' : UNKNOWN;
  };

  const known = new Map<string, number>();
  let unknownCosts = 0;
  const addCost = (m: Money | null) => {
    if (m === null) {
      unknownCosts += 1;
      return;
    }
    known.set(m.currency, (known.get(m.currency) ?? 0) + m.amountMinor);
  };

  const lines: PrintLine[] = [];
  const push = (style: LineStyle, text: string) => lines.push({ style, text });
  const c = trip.constraints;
  push('title', trip.title);
  push('detail', `期間: ${c.startDate}〜${c.endDate} ・ 地域: ${c.area} ・ 交通: ${TRANSPORT_LABEL[c.transportMode]}`);
  push('detail', `版: ${trip.revision} ・ 出力: ${localParts(now.toISOString(), c.timeZone).date} ${localParts(now.toISOString(), c.timeZone).time} (${c.timeZone})`);

  let printedItems = 0;
  let totalItems = 0;
  const body: PrintLine[] = [];
  const add = (style: LineStyle, text: string) => body.push({ style, text });
  if (trip.days.length === 0) add('note', '日程はまだありません。');
  for (const day of trip.days) {
    const mode = TRANSPORT_LABEL[c.transportModeByDate?.[day.date] ?? c.transportMode];
    add('heading', dayHeading(day.date, day.timeZone, mode));
    if (day.items.length === 0) add('note', 'この日の予定はまだありません。');
    for (const item of day.items) {
      totalItems += 1;
      if (item.type === 'activity') {
        printedItems += 1;
        const flags = [item.fixed ? '固定予定' : null, item.status === 'completed' ? '訪問済み' : null, item.status === 'skipped' ? '中止' : null].filter(Boolean);
        add('item', `${span(item.start, item.end, day.date, day.timeZone)}  [${KIND_LABEL[item.kind]}] ${item.title}${flags.length ? `（${flags.join('・')}）` : ''}`);
        const place = isPrivate(item.placeId) ? undefined : exportable(item.placeId, item.title);
        const where = isPrivate(item.placeId)
          ? privateLabel(item.placeId)
          : [place?.name, item.areaName].filter((v): v is string => Boolean(v)).join(' / ') ||
            (item.placeId !== null && places.has(item.placeId) ? '（出力できない場所）' : UNKNOWN);
        add('detail', `場所: ${where}`);
        if (place) add('detail', `営業時間: ${place.openingHours ?? UNKNOWN}`);
        add('detail', `費用: ${formatMoney(item.cost)}`);
        if (item.status !== 'skipped') addCost(item.cost);
        if (place?.provenance.attribution) {
          add('detail', `出典: ${place.provenance.attribution}`);
          attributions.add(place.provenance.attribution);
        }
        if (place?.photo) photosNotDrawn += 1;
        if (place?.dataStatus === 'fixture' || item.costStatus === 'fixture') fixture = true;
        continue;
      }
      // Leg: everything about it comes from its provider, so a leg that may not be exported is left out entirely.
      if (item.provenance !== null && !item.provenance.mayExport) {
        withhold('leg', item.legId, `${day.date} の移動区間`);
        addCost(null);
        continue;
      }
      printedItems += 1;
      const from = placeName(item.fromPlaceId, '移動の出発');
      const to = placeName(item.toPlaceId, '移動の到着');
      add('item', `${span(item.departure, item.arrival, day.date, day.timeZone)}  [移動・${MODE_LABEL[item.mode]}] ${from} → ${to}`);
      add('detail', `所要: ${duration(item.durationSeconds)}`);
      if (item.mode === 'transit') {
        add('detail', `路線: ${item.lineName ?? UNKNOWN} ・ 乗り場: ${item.platform ?? UNKNOWN} ・ 乗換: ${item.transfers === null ? UNKNOWN : `${item.transfers}回`}`);
        const t = item.transit;
        add('detail', `乗車: ${t?.boardingStop ?? UNKNOWN} ・ 降車: ${t?.alightingStop ?? UNKNOWN}${t && t.transferStops.length ? ` ・ 乗換駅: ${t.transferStops.join('、')}` : ''}`);
      } else if (item.lineName) {
        add('detail', `経路: ${item.lineName}`);
      }
      if (item.mode !== 'walk') {
        add('detail', `運賃・料金: ${formatMoney(item.fare)}`);
        addCost(item.fare);
      }
      if (item.provenance?.attribution) {
        add('detail', `出典: ${item.provenance.attribution}`);
        attributions.add(item.provenance.attribution);
      }
      if (item.dataStatus === 'fixture') fixture = true;
    }
  }

  if (fixture) push('note', FIXTURE_NOTE);
  lines.push(...body);

  push('heading', '費用の合計（分かっている分のみ）');
  if (known.size === 0) push('detail', '分かっている費用: なし');
  for (const [currency, amountMinor] of [...known.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    push('detail', `${currency}: ${formatMoney({ amountMinor, currency })}`);
  }
  push('detail', `費用が不明な項目: ${unknownCosts}件（合計に含みません）`);

  push('heading', '出典・注意');
  for (const a of [...attributions].sort()) push('detail', a);
  if (photosNotDrawn > 0) push('detail', `写真 ${photosNotDrawn}件は印刷版に含めていません（外部の画像を読み込まないため）。`);
  push('detail', '地図画像は含みません。時刻・運賃・営業時間は出力時点の旅程の内容で、最新の情報ではありません。');

  if (withheld.length > 0) {
    push('heading', '出力できない項目');
    push('detail', '提供元の利用条件により、次の項目は含めていません。');
    for (const w of withheld) push('detail', `・${w.label}`);
  }

  return {
    lines,
    withheld,
    printedItems,
    nothingExportable: totalItems > 0 && printedItems === 0,
    filename: `trip-${trip.tripId}.pdf`,
  };
}
