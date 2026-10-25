import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Trip } from '@tkb/contracts';
import { FIXTURE_NOTICE } from '@tkb/fixtures';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { formatDay } from '../../lib/format.ts';
import { createMockApi } from '../../mocks/index.ts';
import { fetchTrip, fetchTripFromMock, type TripLoad } from '../itinerary/api.ts';
import { ItineraryTable } from '../itinerary/ItineraryTable.tsx';
import { MapPanel, type MapMarker } from '../itinerary/MapPanel.tsx';
import { readBrowserMapsKey } from '../itinerary/mapsKey.ts';
import { mapPoints, unlocatedPlaces } from '../itinerary/model.ts';
import { tableRows } from '../itinerary/table.ts';
import type { GeoLike } from '../travel/geo.ts';
import {
  AMENITY_KIND_LABEL, EMPTY_TEXT, SHELTER_WARNING, UNSUPPORTED_TEXT,
  chooseArea, currentDayIndex, displayName, fetchAmenities, fetchGuide, filterKinds, hazardText, isFictional, mergeGuide, mockAmenities,
  spotDetail, warningFor, type AmenitiesLoad, type AmenityItem, type AmenityKind, type GuideLoad, type SpotDetail,
} from './model.ts';
import type { GuideRoute } from './route.ts';
import '../../components/u01.css';
import '../itinerary/itinerary.css';
import './guide.css';

const ALL_KINDS: readonly AmenityKind[] = ['toilet', 'evacuation_site', 'evacuation_shelter'];
/** Map symbol per kind; the list rows carry the same symbol so the two correspond. */
export const AMENITY_MARK: Record<AmenityKind, { label: string; color: string }> = {
  toilet: { label: 'ト', color: '#0f766e' },
  evacuation_site: { label: '緊', color: '#b91c1c' },
  evacuation_shelter: { label: '避', color: '#7c3aed' },
};

/** Amenities of the enabled kinds as map symbols (the list below the map shows the same items). */
export function amenityMarkers(load: AmenitiesLoad | null, enabled: ReadonlySet<AmenityKind>): MapMarker[] {
  if (load?.state !== 'ok') return [];
  return filterKinds(load.items, enabled).map(i => ({
    id: `am:${i.id}`, lat: i.location.lat, lng: i.location.lng, label: AMENITY_MARK[i.kind].label, color: AMENITY_MARK[i.kind].color,
    title: `${AMENITY_KIND_LABEL[i.kind]}: ${displayName(i)}`,
  }));
}
const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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

export function GuideView({ trip, mock, geo, today }: { trip: Trip; mock: boolean; geo: GeoLike | null; today: string }) {
  const [dayIndex, setDayIndex] = useState(() => currentDayIndex(trip, today));
  const day = trip.days[Math.min(dayIndex, Math.max(trip.days.length - 1, 0))];
  const points = useMemo(() => (day ? mapPoints(day, trip.places) : []), [day, trip.places]);
  const [selected, setSelected] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<ReadonlySet<AmenityKind>>(new Set(ALL_KINDS));
  const [amen, setAmen] = useState<AmenitiesLoad | null>(null);
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

  // The day's itinerary right under the map; its numbers are the map's point numbers.
  const rows = useMemo(() => (day ? tableRows(day, trip.places) : []), [day, trip.places]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const selectedKeys = useMemo(() => new Set(rows.flatMap(r => (r.kind === 'stay' && selected !== null && r.item.placeId === selected ? [r.key] : []))), [rows, selected]);
  const markers = useMemo(() => amenityMarkers(amen, enabled), [amen, enabled]);
  const highlighted = useMemo(() => new Set(selected ? [selected] : []), [selected]);
  // The row the explanation is shown under: the one last opened, else the first row of the selected place.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const pick = (id: string) => {
    setSelected(s => (s === id ? null : id));
    const key = rows.find(r => r.kind === 'stay' && r.item.placeId === id)?.key;
    if (key) rowRefs.current.get(key)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };
  const toggleRow = (key: string) => {
    const opening = !expanded.has(key);
    setExpanded(s => { const n = new Set(s); if (opening) n.add(key); else n.delete(key); return n; });
    const r = rows.find(x => x.key === key);
    const placeId = r?.kind === 'stay' ? r.item.placeId : null;
    if (placeId) setSelected(s => (opening ? placeId : s === placeId ? null : s));
    if (opening) setFocusKey(key);
  };
  const spotKey = focusKey !== null && selectedKeys.has(focusKey) ? focusKey : rows.find(r => selectedKeys.has(r.key))?.key ?? null;

  return (
    <>
      {trip.places.some(p => p.dataStatus === 'fixture') && <p className="it-fixture" role="note"><strong>FIXTURE</strong> {FIXTURE_NOTICE}</p>}
      {trip.days.length > 1 && (
        <div className="it-days" role="tablist" aria-label="日付">
          {trip.days.map((d, i) => (
            <button key={d.date} type="button" role="tab" aria-selected={d === day} className={`it-day${d === day ? ' it-on' : ''}`} onClick={() => { setDayIndex(i); setSelected(null); setExpanded(new Set()); }}>
              {i + 1}日目 {formatDay(d.date)}
            </button>
          ))}
        </div>
      )}
      <section aria-label="今日の地点" className="gd-sec">
        <h2>今日の地点</h2>
        {!day || points.length === 0 ? <p className="u1-empty">この日に位置のある地点はありません。</p> : (
          <>
            <MapPanel apiKey={readBrowserMapsKey()} points={points} highlighted={highlighted} onSelectPlace={pick} markers={markers} />
            {day && unlocatedPlaces(day, trip.places).length > 0 && <p className="meta">位置不明: {unlocatedPlaces(day, trip.places).map(u => u.name).join('、')}</p>}
          </>
        )}
        {day && rows.length > 0 && (
          <ItineraryTable key={day.date} rows={rows} dayDate={day.date} expanded={expanded} selectedKeys={selectedKeys} onToggleRow={toggleRow}
            setRowRef={(key, el) => { if (el) rowRefs.current.set(key, el); else rowRefs.current.delete(key); }}
            stayExtra={r => (r.key === spotKey ? <SpotPanel detail={detail} guide={guide && guide.placeId === selected ? guide.load : null} /> : null)} />
        )}
      </section>

      <section aria-label="近くのトイレ・避難場所" className="gd-sec">
        <h2>近くのトイレ・避難場所</h2>
        <button type="button" className="btn" onClick={() => { void run(true); }}>現在地を使う</button>
        <fieldset className="gd-layers">
          <legend>表示する種類</legend>
          {ALL_KINDS.map(k => (
            <label key={k}><input type="checkbox" checked={enabled.has(k)} onChange={() => toggle(k)} /> {AMENITY_KIND_LABEL[k]}</label>
          ))}
        </fieldset>
        {note && <p className="meta" role="status">{note}</p>}
        <AmenitiesPanel load={amen} enabled={enabled} onRetry={() => { void run(false); }} />
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

const SHELTER_NOTE = `指定は「現在開設中」を意味しません。${SHELTER_WARNING}`;

/** Four distinct outcomes: error (retry), unsupported region, empty (covered, nothing found), and the list. */
export function AmenitiesPanel({ load, enabled, onRetry }: { load: AmenitiesLoad | null; enabled: ReadonlySet<AmenityKind>; onRetry: () => void }) {
  if (load === null) return <p className="u1-loading" role="status">近くのトイレ・避難場所を探しています…</p>;
  if (load.state === 'error') {
    return <ErrorBox title="トイレ・避難場所を取得できませんでした" error={{ message: load.message, ...(load.code ? { code: load.code } : {}), ...(load.requestId ? { requestId: load.requestId } : {}) }} onRetry={onRetry} />;
  }
  if (load.state === 'unsupported') {
    return <div className="u1-empty" role="status"><p><strong>{UNSUPPORTED_TEXT}</strong></p>{load.reason && <p className="meta">{load.reason}</p>}<p className="meta">対応範囲: {load.supportedRegion}</p></div>;
  }
  if (load.state === 'empty') return <div className="u1-empty" role="status"><p>{EMPTY_TEXT}</p>{load.reason && <p className="meta">{load.reason}</p>}</div>;
  const shown = filterKinds(load.items, enabled);
  const hasShelter = load.items.some(i => i.kind !== 'toilet');
  return (
    <>
      {hasShelter && <p className="gd-warn" role="note">{SHELTER_NOTE}</p>}
      {load.items.some(isFictional) && <p className="it-fixture" role="note"><strong>【架空】</strong> 架空のfixtureデータです。実在の施設・公式データではありません。</p>}
      {shown.length === 0 ? <p className="u1-empty">選んだ種類に該当なし</p> : (
        <ul className="gd-list" aria-label="トイレ・避難場所">
          {shown.map(i => <AmenityRow key={i.id} item={i} />)}
        </ul>
      )}
      {load.fetchedAt && <p className="meta">取得日: {load.fetchedAt}</p>}
    </>
  );
}

function AmenityRow({ item }: { item: AmenityItem }) {
  const warn = warningFor(item);
  return (
    <li className={`gd-am gd-${item.kind}`}>
      <span className="gd-mark" style={{ background: AMENITY_MARK[item.kind].color }} aria-hidden="true">{AMENITY_MARK[item.kind].label}</span>{' '}
      <strong>{displayName(item)}</strong> <span className="gd-kind">{AMENITY_KIND_LABEL[item.kind]}</span>
      {item.kind === 'toilet' && <span className="meta"> 車いす: {item.accessible === true ? '可' : item.accessible === false ? '不可' : '不明'} / 営業時間: {item.openingHours ?? '不明'}</span>}
      {item.kind !== 'toilet' && <span className="meta"> {hazardText(item)}</span>}
      {warn && <p className="gd-warn">{warn}</p>}
      <span className="meta">出典: {item.provenance.attribution}</span>
    </li>
  );
}
