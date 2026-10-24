import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Trip } from '@tkb/contracts';
import { FIXTURE_NOTICE } from '@tkb/fixtures';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { formatDay } from '../../lib/format.ts';
import { createMockApi } from '../../mocks/index.ts';
import { fetchTrip, fetchTripFromMock, type TripLoad } from '../itinerary/api.ts';
import { MapPanel } from '../itinerary/MapPanel.tsx';
import { readBrowserMapsKey } from '../itinerary/mapsKey.ts';
import { mapPoints, unlocatedPlaces } from '../itinerary/model.ts';
import type { GeoLike } from '../travel/geo.ts';
import {
  AMENITY_KIND_LABEL, EMPTY_TEXT, LOCATION_CONSENT_TEXT, SHELTER_WARNING, UNSUPPORTED_TEXT,
  chooseArea, currentDayIndex, displayName, fetchAmenities, filterKinds, hazardText, isFictional, mockAmenities,
  spotDetail, warningFor, type AmenitiesLoad, type AmenityItem, type AmenityKind, type SpotDetail,
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
  const toggle = (k: AmenityKind) => setEnabled(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pick = (id: string) => setSelected(s => (s === id ? null : id));

  return (
    <>
      {trip.places.some(p => p.dataStatus === 'fixture') && <p className="it-fixture" role="note"><strong>FIXTURE</strong> {FIXTURE_NOTICE}</p>}
      {trip.days.length > 1 && (
        <div className="it-days" role="tablist" aria-label="日付">
          {trip.days.map((d, i) => (
            <button key={d.date} type="button" role="tab" aria-selected={d === day} className={`it-day${d === day ? ' it-on' : ''}`} onClick={() => { setDayIndex(i); setSelected(null); }}>
              {i + 1}日目 {formatDay(d.date)}
            </button>
          ))}
        </div>
      )}
      <section aria-label="今日の地点" className="gd-sec">
        <h2>今日の地点</h2>
        {!day || points.length === 0 ? <p className="u1-empty">この日に位置のある地点はありません。</p> : (
          <>
            <MapPanel apiKey={readBrowserMapsKey()} points={points} highlighted={new Set(selected ? [selected] : [])} onSelectPlace={pick} />
            <ol className="gd-list">
              {points.map(p => (
                <li key={p.placeId}>
                  <button type="button" className={`it-item${selected === p.placeId ? ' it-on' : ''}`} aria-pressed={selected === p.placeId} onClick={() => pick(p.placeId)}>
                    <span className="it-num">{p.number}</span> {p.name}
                  </button>
                </li>
              ))}
            </ol>
            {day && unlocatedPlaces(day, trip.places).length > 0 && <p className="meta">位置不明: {unlocatedPlaces(day, trip.places).map(u => u.name).join('、')}</p>}
          </>
        )}
        <SpotPanel detail={detail} />
      </section>

      <section aria-label="近くのトイレ・避難場所" className="gd-sec">
        <h2>近くのトイレ・避難場所</h2>
        <p className="meta" role="note">{LOCATION_CONSENT_TEXT}</p>
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

export function SpotPanel({ detail }: { detail: SpotDetail | null }) {
  if (!detail) return <p className="meta">地点を選ぶと解説を表示します。</p>;
  return (
    <article className="gd-detail" aria-label={`地点${detail.number}の解説`}>
      <h3><span className="it-num">{detail.number}</span> {detail.name}</h3>
      <p className={detail.hasDescription ? '' : 'u1-unknown'}>{detail.description}</p>
      {detail.photo && (
        <figure>
          <img src={detail.photo.url} alt={`${detail.name}の写真`} loading="lazy" />
          <figcaption>写真: {detail.photo.attribution}{detail.photo.license ? `（${detail.photo.license}）` : ''}</figcaption>
        </figure>
      )}
      <p className="meta">出典: {detail.source}{detail.fictional ? '（架空のfixtureデータ）' : ''}</p>
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
      <strong>{displayName(item)}</strong> <span className="gd-kind">{AMENITY_KIND_LABEL[item.kind]}</span>
      {item.kind === 'toilet' && <span className="meta"> 車いす: {item.accessible === true ? '可' : item.accessible === false ? '不可' : '不明'} / 営業時間: {item.openingHours ?? '不明'}</span>}
      {item.kind !== 'toilet' && <span className="meta"> {hazardText(item)}</span>}
      {warn && <p className="gd-warn">{warn}</p>}
      <span className="meta">出典: {item.provenance.attribution}</span>
    </li>
  );
}
