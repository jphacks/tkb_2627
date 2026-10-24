/**
 * U04 (R05, R06, R08): pure view-model for the map + itinerary screen.
 * No React, no network: everything here is unit-tested directly.
 * Unknown values are never turned into 0: times are 未定, duration/fare/platform are 不明.
 */
import type { Activity, ItineraryItem, PlaceInfo, TransportMode, TravelLeg, Trip, TripDay, ZonedTime } from '@tkb/contracts';
import { formatDuration, formatMoney } from '../../lib/format.ts';
import { highlightFor, itemKey, numberPlaces, type Selection } from '../../lib/places.ts';

export const TIME_UNKNOWN = '未定';
export const VALUE_UNKNOWN = '不明';

export const KIND_LABEL: Record<Activity['kind'], string> = { visit: '訪問', meal: '食事', free_walk: '自由散策', lodging: '宿泊', custom: 'その他' };
export const LEG_MODE_LABEL: Record<TravelLeg['mode'], string> = { transit: '公共交通', car: '車', walk: '徒歩' };
export const DAY_MODE_LABEL: Record<TransportMode, string> = { transit: '公共交通', car: '車' };

/** R06: the day's transport mode. Days not listed in transportModeByDate use the trip's mode. */
export function dayTransportMode(trip: Trip, date: string): TransportMode {
  return trip.constraints.transportModeByDate?.[date] ?? trip.constraints.transportMode;
}

/** YYYY-MM-DD of an instant in a zone (en-CA formats as ISO date). */
function localDate(t: ZonedTime): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: t.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t.utc));
}

/**
 * Local time in the item's own IANA zone, e.g. "09:30 JST". null is 未定.
 * When the local date differs from the day's date (overnight, crossing zones) the date is prefixed.
 */
export function formatLocalTime(t: ZonedTime | null, dayDate: string): string {
  if (t === null) return TIME_UNKNOWN;
  const d = new Date(t.utc);
  const time = new Intl.DateTimeFormat('ja-JP', { timeZone: t.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const zone = new Intl.DateTimeFormat('ja-JP', { timeZone: t.timeZone, timeZoneName: 'short' })
    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? t.timeZone;
  const date = localDate(t);
  const prefix = date === dayDate ? '' : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} `;
  return `${prefix}${time} ${zone}`;
}

export function fareText(m: TravelLeg['fare']): string {
  return m === null ? VALUE_UNKNOWN : formatMoney(m);
}
export function durationText(s: number | null): string {
  return s === null ? VALUE_UNKNOWN : formatDuration(s);
}

export interface TransitDetail {
  line: string;
  boarding: string;
  alighting: string;
  transfers: string[];
  transferCount: string;
  platform: string;
}

/** R05: line, stops, platform and transfers. Only what the provider returned; the rest is 不明. */
export function transitDetail(leg: TravelLeg): TransitDetail | null {
  if (leg.mode !== 'transit') return null;
  return {
    line: leg.lineName ?? VALUE_UNKNOWN,
    boarding: leg.transit?.boardingStop ?? VALUE_UNKNOWN,
    alighting: leg.transit?.alightingStop ?? VALUE_UNKNOWN,
    transfers: leg.transit?.transferStops ?? [],
    transferCount: leg.transfers === null ? VALUE_UNKNOWN : `${leg.transfers}回`,
    platform: leg.platform ?? VALUE_UNKNOWN,
  };
}

export interface TimelineRow {
  key: string;
  item: ItineraryItem;
  /** Map marker number(s) of the item's places (empty when it has no known place). */
  numbers: number[];
  title: string;
  start: string;
  end: string;
}

export function placeNameOf(places: PlaceInfo[], id: string | null): string {
  if (id === null) return VALUE_UNKNOWN;
  return places.find(p => p.placeId === id)?.name ?? VALUE_UNKNOWN;
}

export function timelineRows(day: TripDay, places: PlaceInfo[]): TimelineRow[] {
  const numbered = new Map(numberPlaces(day, places).map(n => [n.place.placeId, n.number]));
  return day.items.map(item => {
    if (item.type === 'activity') {
      const n = item.placeId ? numbered.get(item.placeId) : undefined;
      return {
        key: itemKey(item), item, numbers: n === undefined ? [] : [n], title: item.title,
        start: formatLocalTime(item.start, day.date), end: formatLocalTime(item.end, day.date),
      };
    }
    const nums = [numbered.get(item.fromPlaceId), numbered.get(item.toPlaceId)].filter((n): n is number => n !== undefined);
    return {
      key: itemKey(item), item, numbers: nums,
      title: `${placeNameOf(places, item.fromPlaceId)} → ${placeNameOf(places, item.toPlaceId)}`,
      start: formatLocalTime(item.departure, day.date), end: formatLocalTime(item.arrival, day.date),
    };
  });
}

export interface MapPoint {
  placeId: string;
  number: number;
  name: string;
  lat: number;
  lng: number;
}

/** Numbered places of the day that have a location (markers), in order of first appearance (polyline order). */
export function mapPoints(day: TripDay, places: PlaceInfo[]): MapPoint[] {
  return numberPlaces(day, places).flatMap(({ number, place }) =>
    place.location ? [{ placeId: place.placeId, number, name: place.name, lat: place.location.lat, lng: place.location.lng }] : []);
}

/** Numbered places without a location: listed as 位置不明, never placed at 0,0. */
export function unlocatedPlaces(day: TripDay, places: PlaceInfo[]): { number: number; name: string }[] {
  return numberPlaces(day, places).filter(n => n.place.location === null).map(n => ({ number: n.number, name: n.place.name }));
}

export interface SyncState {
  selection: Selection;
  itemKeys: Set<string>;
  placeIds: Set<string>;
  /** The timeline item to open/scroll to (R08: selecting on the map opens the matching item). */
  focusItemKey: string | null;
}

/**
 * R08 selection sync. Timeline -> map: the item's places are highlighted.
 * Map -> timeline: the items using the place are highlighted and the first of them is opened.
 */
export function syncSelection(selection: Selection, day: TripDay): SyncState {
  const { itemKeys, placeIds } = highlightFor(selection, day);
  let focusItemKey: string | null = null;
  if (selection?.kind === 'item') focusItemKey = itemKeys.has(selection.key) ? selection.key : null;
  else if (selection?.kind === 'place') focusItemKey = day.items.map(itemKey).find(k => itemKeys.has(k)) ?? null;
  return { selection, itemKeys, placeIds, focusItemKey };
}

/** Clicking the selected thing again clears the selection. */
export function toggleSelection(current: Selection, next: Exclude<Selection, null>): Selection {
  if (current && current.kind === next.kind) {
    if (current.kind === 'item' && next.kind === 'item' && current.key === next.key) return null;
    if (current.kind === 'place' && next.kind === 'place' && current.placeId === next.placeId) return null;
  }
  return next;
}

export interface Attribution {
  /** Google Maps Platform data is shown (requires Google map or Google attribution). */
  usesGoogle: boolean;
  /** Provider attribution strings (deduplicated), e.g. third-party credits returned with Places. */
  providers: string[];
  /** Photo credits (author / license). */
  photos: string[];
  /** Fixture or unknown data is present. */
  hasFixture: boolean;
}

/** Attribution needed for the trip's displayed data (docs/provider-probe.md display rules). */
export function attributionFor(trip: Trip): Attribution {
  const provs = [
    ...trip.places.map(p => p.provenance),
    ...trip.days.flatMap(d => d.items).flatMap(i => (i.type === 'leg' && i.provenance ? [i.provenance] : [])),
  ];
  const usesGoogle = provs.some(p => p.source.startsWith('google'));
  const providers = [...new Set(provs.map(p => p.attribution).filter((a): a is string => !!a))];
  const photos = [...new Set(trip.places.flatMap(p => (p.photo ? [p.photo.license ? `${p.photo.attribution}（${p.photo.license}）` : p.photo.attribution] : [])))];
  const hasFixture = provs.some(p => p.source === 'fixture') || trip.places.some(p => p.dataStatus === 'fixture');
  return { usesGoogle, providers, photos, hasFixture };
}
