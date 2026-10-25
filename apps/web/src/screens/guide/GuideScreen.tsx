import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Trip } from '@tkb/contracts';
import { FIXTURE_NOTICE } from '@tkb/fixtures';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { formatDay } from '../../lib/format.ts';
import { createMockApi } from '../../mocks/index.ts';
import { fetchTrip, fetchTripFromMock, type TripLoad } from '../itinerary/api.ts';
import { MapPanel, type ExtraMarker } from '../itinerary/MapPanel.tsx';
import { ItineraryTable } from '../itinerary/ItineraryTable.tsx';
import { tableRows } from '../itinerary/table.ts';
import { readBrowserMapsKey } from '../itinerary/mapsKey.ts';
import { mapPoints, unlocatedPlaces } from '../itinerary/model.ts';
import type { GeoLike } from '../travel/geo.ts';
import {
  AMENITY_KIND_LABEL, EMPTY_TEXT, SHELTER_WARNING, UNSUPPORTED_TEXT,
  chooseArea, currentDayIndex, displayName, fetchAmenities, fetchGuide, filterKinds, isFictional, mergeGuide, mockAmenities,
  spotDetail, warningFor, type AmenitiesLoad, type AmenityItem, type AmenityKind, type GuideLoad, type SpotDetail,
} from './model.ts';
import type { GuideRoute } from './route.ts';
import '../../components/u01.css';
import '../itinerary/itinerary.css';
import './guide.css';

const ALL_KINDS: readonly AmenityKind[] = ['toilet', 'evacuation_site', 'evacuation_shelter'];
const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const MARKER_STYLE: Record<AmenityKind, Pick<ExtraMarker, 'shape' | 'glyph' | 'color'>> = {
  toilet: { shape: 'square', glyph: 'WC', color: '#0f766e' },
  evacuation_site: { shape: 'triangle', glyph: '避', color: '#7c3aed' },
  evacuation_shelter: { shape: 'diamond', glyph: '所', color: '#b91c1c' },
};
const SHELTER_NOTE = `指定は「現在開設中」を意味しません。${SHELTER_WARNING}`;
const NO_EXPANDED: ReadonlySet<string> = new Set();

/** Map markers for the amenities whose layer is on: one marker per item, shape/glyph/colour by kind. Pure. */
export function amenityMarkers(items: readonly AmenityItem[], enabled: ReadonlySet<AmenityKind>): ExtraMarker[] {
  return filterKinds([...items], enabled).map(i => ({ id: i.id, lat: i.location.lat, lng: i.location.lng, title: `${AMENITY_KIND_LABEL[i.kind]}: ${displayName(i)}`, ...MARKER_STYLE[i.kind] }));
}

/** U07 guide screen: loads the trip (K09 or mock), then amenities (K19). Coordinates are never stored. */
export function GuideScreen({ route, geo, today, onBack }: { route: GuideRoute; geo?: GeoLike | null; today?: string; onBack?: () => void }) {
  const [load, setLoad] = useState<TripLoad | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoad(null);
    const p = route.mode === 'mock' ? fetchTripFromMock(createMockApi(), route.tripId) : fetchTrip(route.tripId, { signal: ctrl.signal });
    p.then(setLoad, () => { /* aborted */ });
    return () => ctrl.abort();
  }, [route.mode, route.tripId, attempt]);

  const header = <ScreenHeader title="現在地とデジタルガイド" {...(onBack ? { onBack } : {})} />;
  let body;
  if (load === null) body = <p className="u1-loading" role="status">旅程を読み込み中…</p>;
  else if (load.state === 'notFound') body = <div className="u1-empty" role="alert"><p>旅程が見つかりません（404）。</p></div>;
  else if (load.state === 'unauthenticated') body = <div className="u1-empty" role="alert"><p>ログインが必要です（401）。</p></div>;
  else if (load.state === 'error') body = <ErrorBox title="旅程を読み込めませんでした" error={{ message: load.message }} onRetry={() => setAttempt(a => a + 1)} />;
  else body = <GuideView trip={load.trip} mock={route.mode === 'mock'} geo={geo === undefined ? (typeof navigator !== 'undefined' ? navigator.geolocation : null) : geo} today={today ?? todayLocal()} />;
  return (
    <div className="u1-root">
      {route.mode === 'mock' && <MockBanner />}
      <main className="u1-main" aria-label="現在地とデジタルガイド">{header}{body}</main>
    </div>
  );
}

/**
 * Taps that keep the current highlight: controls, markers, table rows and the detail texts. Taps inside the Google map
 * canvas are left to its own click event, which fires only off the markers. Everything else clears (UI review on #35).
 */
const KEEP_SELECTION = 'button, a, input, label, select, textarea, summary, [role="button"], [role="tab"], .it-map-canvas, .gd-pop, .gd-detail, .it-detail, .it-stay';
export function clearsSelection(target: { closest(selector: string): unknown } | null): boolean {
  return target !== null && !target.closest(KEEP_SELECTION);
}

export function GuideView({ trip, mock, geo, today, initialAmenities = null, initialSelected = null, initialPickedAmenity = null, initialEnabled }: { trip: Trip; mock: boolean; geo: GeoLike | null; today: string; initialAmenities?: AmenitiesLoad | null; initialSelected?: string | null; initialPickedAmenity?: string | null; initialEnabled?: ReadonlySet<AmenityKind> }) {
  const [dayIndex, setDayIndex] = useState(() => currentDayIndex(trip, today));
  const day = trip.days[Math.min(dayIndex, Math.max(trip.days.length - 1, 0))];
  const points = useMemo(() => (day ? mapPoints(day, trip.places) : []), [day, trip.places]);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [pickedAmenity, setPickedAmenity] = useState<string | null>(initialPickedAmenity);
  const [enabled, setEnabled] = useState<ReadonlySet<AmenityKind>>(initialEnabled ?? new Set(ALL_KINDS));
  const [amen, setAmen] = useState<AmenitiesLoad | null>(initialAmenities);
  const [note, setNote] = useState<string | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (useDevice: boolean) => {
    const my = ++seq.current;
    setAmen(null);
    setNote(null);
    const homePlaceIds = [trip.constraints.departure?.placeId, trip.constraints.return?.placeId].filter((x): x is string => typeof x === 'string');
    const area = await chooseArea({ useDevice, geo, day, places: trip.places, homePlaceIds });
    if (my !== seq.current) return;
    if (area.deviceFailure) setNote(area.deviceFailure === 'denied' ? '位置情報が許可されなかったため、旅程の地点の周辺を表示しています。' : '現在地を取得できなかったため、旅程の地点の周辺を表示しています。');
    if (area.source === 'none') { setAmen({ state: 'empty', reason: '旅程に位置のある地点がありません。', dataStatus: 'unknown' }); return; }
    if (area.source === 'device') setNote('現在地の周辺を表示しています（座標は保存していません）。');
    const r = mock ? mockAmenities(area.bbox) : await fetchAmenities(area.bbox);
    if (my === seq.current) setAmen(r);
  }, [geo, day, trip.places, mock]);

  // Initial load uses the trip's places only: no location is requested without the button.
  useEffect(() => { void run(false); }, [run]);

  const detail = useMemo(() => {
    const p = points.find(x => x.placeId === selected);
    return p ? spotDetail(p, trip.places) : null;
  }, [points, selected, trip.places]);
  const [guide, setGuide] = useState<{ placeId: string; load: GuideLoad } | null>(null);
  useEffect(() => {
    setGuide(null);
    if (!selected || mock) return undefined; // mock mode: no network, Trip.places only
    const ctrl = new AbortController();
    fetchGuide(selected, { signal: ctrl.signal }).then(load => setGuide({ placeId: selected, load }), () => { /* aborted */ });
    return () => ctrl.abort();
  }, [selected, mock]);
  const toggle = (k: AmenityKind) => setEnabled(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pick = (id: string) => setSelected(s => (s === id ? null : id));
  const rows = useMemo(() => (day ? tableRows(day, trip.places) : []), [day, trip.places]);
  const selectedKeys = useMemo(() => new Set(rows.flatMap(r => (r.kind === 'stay' && selected !== null && r.item.placeId === selected ? [r.key] : []))), [rows, selected]);
  // Selecting a stay row selects its map point (and the guide detail); legs have no map point.
  const selectRow = (key: string) => {
    const r = rows.find(x => x.key === key);
    if (r?.kind === 'stay' && r.item.placeId && points.some(p => p.placeId === r.item.placeId)) pick(r.item.placeId);
  };
  const markers = useMemo(() => (amen?.state === 'ok' ? amenityMarkers(amen.items, enabled) : []), [amen, enabled]);
  const amenityPicked = markers.some(m => m.id === pickedAmenity) && amen?.state === 'ok' ? amen.items.find(i => i.id === pickedAmenity) ?? null : null;

  // Tapping anywhere else on the screen or the map (or Escape) brings the highlight back to normal.
  const clearSelection = useCallback(() => { setSelected(null); setPickedAmenity(null); }, []);
  const hasSelection = selected !== null || pickedAmenity !== null;
  useEffect(() => {
    if (!hasSelection) return undefined;
    const onClick = (e: MouseEvent) => { if (clearsSelection(e.target instanceof Element ? e.target : null)) clearSelection(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clearSelection(); };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); };
  }, [hasSelection, clearSelection]);

  return (
    <>
      {trip.places.some(p => p.dataStatus === 'fixture') && <p className="it-fixture" role="note"><strong>FIXTURE</strong> {FIXTURE_NOTICE}</p>}
      {trip.days.length > 1 && (
        <div className="it-days" role="tablist" aria-label="日付">
          {trip.days.map((d, i) => (
            <button key={d.date} type="button" role="tab" aria-selected={d === day} className={`it-day${d === day ? ' it-on' : ''}`} onClick={() => { setDayIndex(i); setSelected(null); setPickedAmenity(null); }}>
              {i + 1}日目 {formatDay(d.date)}
            </button>
          ))}
        </div>
      )}
      <section aria-label="今日の地点" className="gd-sec">
        <h2>今日の地点</h2>
        {!day || points.length === 0 ? <p className="u1-empty">この日に位置のある地点はありません。</p> : (
          <>
            <div className="gd-mapwrap">
              <MapPanel apiKey={readBrowserMapsKey()} points={points} highlighted={new Set(selected ? [selected] : [])} onSelectPlace={pick}
                extraMarkers={markers} onSelectExtra={id => setPickedAmenity(p => (p === id ? null : id))} selectedExtraId={pickedAmenity} onMapBackground={clearSelection} />
              {amenityPicked && (
                <div className="gd-pop" role="status" aria-label="選んだ施設">
                  <strong>{displayName(amenityPicked)}</strong> <span className="gd-kind">{AMENITY_KIND_LABEL[amenityPicked.kind]}</span>
                  {warningFor(amenityPicked) && <p className="gd-warn">{warningFor(amenityPicked)}</p>}
                </div>
              )}
            </div>
            <button type="button" className="btn gd-here" aria-label="現在地を使う（ブラウザの位置情報の許可を確認します）" title="ブラウザの位置情報の許可を確認します" onClick={() => { void run(true); }}>現在地を使う</button>
            {note && <p className="meta" role="status">{note}</p>}
            <AmenityLegend enabled={enabled} onToggle={toggle} />
            {amen?.state === 'ok' && amen.items.some(isFictional) && <p className="it-fixture" role="note"><strong>【架空】</strong> 地図上の施設は架空のfixtureデータです。実在の施設・公式データではありません。</p>}
            {amen?.state === 'ok' && amen.items.some(i => i.kind !== 'toilet') && <p className="gd-warn" role="note">{SHELTER_NOTE}</p>}
            <AmenitiesPanel load={amen} onRetry={() => { void run(false); }} />
            {day && unlocatedPlaces(day, trip.places).length > 0 && <p className="meta">位置不明: {unlocatedPlaces(day, trip.places).map(u => u.name).join('、')}</p>}
            <ItineraryTable rows={rows} dayDate={day.date} expanded={selectedKeys.size > 0 ? selectedKeys : NO_EXPANDED} selectedKeys={selectedKeys} onToggleRow={selectRow} />
          </>
        )}
        <SpotPanel detail={detail} guide={guide && guide.placeId === selected ? guide.load : null} />
      </section>

    </>
  );
}

/** `guide` is null while loading (or in mock mode): the trip's own description is shown meanwhile. */
export function SpotPanel({ detail, guide = null }: { detail: SpotDetail | null; guide?: GuideLoad | null }) {
  if (!detail) return null;
  const view = mergeGuide(detail, guide);
  return (
    <article className="gd-detail" aria-label={`地点${view.number}の解説`}>
      <h3><span className="it-num">{view.number}</span> {view.name}</h3>
      <p className={view.hasDescription ? '' : 'u1-unknown'}>{view.description}</p>
      {view.photo && (
        <figure>
          <img src={view.photo.url} alt={`${view.name}の写真`} loading="lazy" referrerPolicy="no-referrer" />
          <figcaption>
            写真: {view.photo.attribution}（{view.photo.license}） 出典:{' '}
            <a href={view.photo.url} target="_blank" rel="noopener noreferrer">{view.photo.sourceLabel}</a>
          </figcaption>
        </figure>
      )}
      <p className="meta">
        出典: {view.textAttribution ?? view.source}{view.fictional ? '（架空のfixtureデータ）' : ''}
        {guide?.state === 'error' && '（詳しい解説は取得できなかったため、旅程のデータを表示しています）'}
      </p>
    </article>
  );
}


/** Four distinct outcomes: error (retry), unsupported region, empty (covered, nothing found), and the list. */
export function AmenitiesPanel({ load, onRetry }: { load: AmenitiesLoad | null; onRetry: () => void }) {
  if (load === null) return <p className="u1-loading" role="status">近くのトイレ・避難場所を探しています…</p>;
  if (load.state === 'error') {
    return <ErrorBox title="トイレ・避難場所を取得できませんでした" error={{ message: load.message, ...(load.code ? { code: load.code } : {}), ...(load.requestId ? { requestId: load.requestId } : {}) }} onRetry={onRetry} />;
  }
  if (load.state === 'unsupported') {
    return <div className="u1-empty" role="status"><p><strong>{UNSUPPORTED_TEXT}</strong></p>{load.reason && <p className="meta">{load.reason}</p>}<p className="meta">対応範囲: {load.supportedRegion}</p></div>;
  }
  if (load.state === 'empty') return <div className="u1-empty" role="status"><p>{EMPTY_TEXT}</p>{load.reason && <p className="meta">{load.reason}</p>}</div>;
  // The list is not shown (M2 review 3): amenities are read from the map markers.
  return load.fetchedAt ? <p className="meta">施設データ取得日: {load.fetchedAt}</p> : null;
}

/** Legend merged with the layer toggles: each entry is the symbol and a toggle button. */
export function AmenityLegend({ enabled, onToggle }: { enabled: ReadonlySet<AmenityKind>; onToggle: (k: AmenityKind) => void }) {
  return (
    <div className="gd-legend" role="group" aria-label="地図の記号（押すと表示を切り替え）">
      {ALL_KINDS.map(k => (
        <button key={k} type="button" className={`gd-leg${enabled.has(k) ? ' gd-on' : ''}`} aria-pressed={enabled.has(k)} onClick={() => onToggle(k)}>
          <strong style={{ color: MARKER_STYLE[k].color }}>{MARKER_STYLE[k].glyph}</strong> {AMENITY_KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );
}
