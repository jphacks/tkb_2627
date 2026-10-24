/**
 * E01 (R17): pure print view-model. No React, no network.
 * - Unknown times are 未定, unknown values 不明; never 0.
 * - Photos only when the place's provenance allows export (mayExport) AND an author credit exists;
 *   otherwise a text placeholder. Map images are never part of the model (places are listed as text).
 * - Places / legs whose provenance has mayExport=false are withheld, as the K18 server export does.
 */
import type { Photo, PlaceInfo, Trip } from '@tkb/contracts';
import { formatMoney } from '../../lib/format.ts';
import { DAY_MODE_LABEL, KIND_LABEL, LEG_MODE_LABEL, VALUE_UNKNOWN, dayTransportMode, durationText, fareText, formatLocalTime } from '../itinerary/model.ts';

export const PHOTO_PLACEHOLDER = '写真なし（転載不可）';
export const WITHHELD_PLACE = '（転載不可の地点）';
export const MAP_NOTE = '地図画像は掲載していません（利用条件により転載できないため）。訪問地は下の一覧と各予定の地点名で確認してください。';

export interface PrintPhoto { url: string; credit: string }

/** A photo is printable only with export permission and a non-empty author credit. */
export function printablePhoto(place: PlaceInfo | undefined): PrintPhoto | null {
  const photo: Photo | null | undefined = place?.photo;
  if (!place || !photo || !place.provenance.mayExport) return null;
  const author = photo.attribution.trim();
  if (author === '') return null;
  return { url: photo.url, credit: photo.license ? `${author}（${photo.license}）` : author };
}

export interface PrintItem {
  key: string;
  time: string;
  title: string;
  kind: string;
  place: string | null;
  details: string[];
  cost: string;
  photo: PrintPhoto | null;
  /** true when the place has a photo record that cannot be printed. */
  photoPlaceholder: boolean;
  source: string | null;
}
export interface PrintDay { date: string; mode: string; items: PrintItem[] }
export interface CostSummary { perCurrency: string[]; unknownCount: number }
export interface PrintModel {
  title: string;
  period: string;
  days: PrintDay[];
  cost: CostSummary;
  places: string[];
  sources: string[];
  warnings: string[];
}

function placeLabel(places: PlaceInfo[], id: string | null): string {
  if (id === null) return VALUE_UNKNOWN;
  const p = places.find(x => x.placeId === id);
  if (!p) return VALUE_UNKNOWN;
  return p.provenance.mayExport ? p.name : WITHHELD_PLACE;
}

function sourceLine(source: string, attribution: string | null): string {
  return attribution ? `${source}（${attribution}）` : source;
}

export function buildPrintModel(trip: Trip): PrintModel {
  const sums = new Map<string, number>();
  let unknownCount = 0;
  const addCost = (m: { currency: string; amountMinor: number } | null) => {
    if (m === null) { unknownCount += 1; return; }
    sums.set(m.currency, (sums.get(m.currency) ?? 0) + m.amountMinor);
  };
  const sources = new Set<string>();
  const usedPlaces: string[] = [];

  const days: PrintDay[] = trip.days.map(day => {
    const items: PrintItem[] = day.items.map(item => {
      if (item.type === 'activity') {
        const place = item.placeId ? trip.places.find(p => p.placeId === item.placeId) : undefined;
        addCost(item.cost);
        const photo = printablePhoto(place);
        const placeName = item.placeId ? placeLabel(trip.places, item.placeId) : item.areaName;
        let source: string | null = null;
        if (place?.provenance.mayExport) {
          if (!usedPlaces.includes(place.name)) usedPlaces.push(place.name);
          source = sourceLine(place.provenance.source, place.provenance.attribution);
          sources.add(source);
        }
        if (photo) sources.add(`写真: ${photo.credit}`);
        return {
          key: item.activityId,
          time: `${formatLocalTime(item.start, day.date)} - ${formatLocalTime(item.end, day.date)}`,
          title: item.title, kind: KIND_LABEL[item.kind], place: placeName,
          details: place?.provenance.mayExport && place.openingHours ? [`営業時間: ${place.openingHours}`] : [],
          cost: item.cost === null ? `費用: ${VALUE_UNKNOWN}` : `費用: ${formatMoney(item.cost)}`,
          photo, photoPlaceholder: !photo && !!place?.photo, source,
        };
      }
      addCost(item.fare);
      const allowed = item.provenance === null || item.provenance.mayExport;
      let source: string | null = null;
      if (item.provenance && item.provenance.mayExport) {
        source = sourceLine(item.provenance.source, item.provenance.attribution);
        sources.add(source);
      }
      const details = allowed
        ? [`手段: ${LEG_MODE_LABEL[item.mode]}`, `所要: ${durationText(item.durationSeconds)}`,
          ...(item.mode === 'transit' ? [`路線: ${item.lineName ?? VALUE_UNKNOWN}`, `乗換: ${item.transfers === null ? VALUE_UNKNOWN : `${item.transfers}回`}`] : [])]
        : ['（この区間の詳細は転載不可のため省略）'];
      return {
        key: item.legId,
        time: `${formatLocalTime(item.departure, day.date)} - ${formatLocalTime(item.arrival, day.date)}`,
        title: `${placeLabel(trip.places, item.fromPlaceId)} → ${placeLabel(trip.places, item.toPlaceId)}`,
        kind: '移動', place: null, details,
        cost: allowed ? `運賃: ${fareText(item.fare)}` : `運賃: ${VALUE_UNKNOWN}`,
        photo: null, photoPlaceholder: false, source,
      };
    });
    return { date: day.date, mode: DAY_MODE_LABEL[dayTransportMode(trip, day.date)], items };
  });

  const perCurrency = [...sums.entries()].map(([currency, amountMinor]) => formatMoney({ currency, amountMinor }));
  const { startDate, endDate } = trip.constraints;
  return {
    title: trip.title,
    period: startDate === endDate ? startDate : `${startDate} 〜 ${endDate}`,
    days, cost: { perCurrency, unknownCount }, places: usedPlaces,
    sources: [...sources], warnings: trip.warnings,
  };
}

export function costText(c: CostSummary): string {
  const known = c.perCurrency.length ? c.perCurrency.join(' / ') : VALUE_UNKNOWN;
  return c.unknownCount > 0 ? `${known}（費用が不明な項目 ${c.unknownCount} 件は含みません）` : known;
}
