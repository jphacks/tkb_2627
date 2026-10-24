import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Trip } from '@tkb/contracts';
import { FIXTURE_NOTICE } from '@tkb/fixtures';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { formatDay } from '../../lib/format.ts';
import type { Selection } from '../../lib/places.ts';
import { createMockApi, type MockApi } from '../../mocks/index.ts';
import { fetchTrip, fetchTripFromMock, type TripLoad } from './api.ts';
import { MapPanel } from './MapPanel.tsx';
import { readBrowserMapsKey } from './mapsKey.ts';
import {
  DAY_MODE_LABEL, KIND_LABEL, LEG_MODE_LABEL, TIME_UNKNOWN, VALUE_UNKNOWN,
  attributionFor, dayTransportMode, durationText, fareText, mapPoints, syncSelection, timelineRows,
  toggleSelection, transitDetail, unlocatedPlaces, type TimelineRow,
} from './model.ts';
import { itineraryHash, type ItineraryRoute } from './route.ts';
import '../../components/u01.css';
import './itinerary.css';

const NO_PLACES: ReadonlySet<string> = new Set();

/**
 * U04 map + itinerary screen (R05, R06, R08). Loads the trip by id every time it mounts (a reload
 * shows what the server saved). Real mode: K09 GET /api/v1/trips/{id}; mock mode: U01 mock API.
 */
export function ItineraryScreen({ route, mockApi, onBack, embedded = false }: {
  route: ItineraryRoute;
  mockApi?: MockApi;
  onBack?: () => void;
  /** Inside the U01 shell (which has its own banner, <main> and no hash route). */
  embedded?: boolean;
}) {
  const api = useMemo(() => (route.mode === 'mock' ? mockApi ?? createMockApi() : null), [route.mode, mockApi]);
  const [load, setLoad] = useState<TripLoad | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dayIndex, setDayIndex] = useState(route.dayIndex);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad(null);
    const p = api ? fetchTripFromMock(api, route.tripId) : fetchTrip(route.tripId, { signal: ctrl.signal });
    p.then(setLoad, () => { /* aborted */ });
    return () => ctrl.abort();
  }, [api, route.tripId, attempt]);

  const selectDay = useCallback((i: number) => {
    setDayIndex(i);
    if (!embedded && typeof history !== 'undefined') history.replaceState(null, '', itineraryHash({ ...route, dayIndex: i }));
  }, [route, embedded]);

  const body = (
    <ItineraryBody load={load} dayIndex={dayIndex} onSelectDay={selectDay} onRetry={() => setAttempt(a => a + 1)}
      mapsKey={readBrowserMapsKey()} {...(onBack ? { onBack } : {})} />
  );
  if (embedded) return body;

  return (
    <div className="u1-root">
      {route.mode === 'mock' && <MockBanner />}
      <main className="u1-main" aria-label="地図と旅程">{body}</main>
    </div>
  );
}

/** Pure part (no fetching): loading / 404 / error / empty / the itinerary. Rendered directly in tests. */
export function ItineraryBody({ load, dayIndex, onSelectDay, onRetry, mapsKey, onBack }: {
  load: TripLoad | null;
  dayIndex: number;
  onSelectDay: (i: number) => void;
  onRetry: () => void;
  mapsKey: string | null;
  onBack?: () => void;
}) {
  const header = (title: string) => <ScreenHeader title={title} {...(onBack ? { onBack } : {})} />;
  if (load === null) return <>{header('地図と旅程')}<p className="u1-loading" role="status">サーバーから旅程を読み込み中…</p></>;
  if (load.state === 'notFound') {
    return <>{header('地図と旅程')}<div className="u1-empty" role="alert"><p>旅程が見つかりません（404）。削除されたか、閲覧権限がありません。</p></div></>;
  }
  if (load.state === 'unauthenticated') {
    return <>{header('地図と旅程')}<div className="u1-empty" role="alert"><p>ログインが必要です（401）。ログインしてから再読み込みしてください。</p></div></>;
  }
  if (load.state === 'error') {
    return (
      <>
        {header('地図と旅程')}
        <ErrorBox title="旅程を読み込めませんでした" onRetry={onRetry}
          error={{ message: load.message, ...(load.code ? { code: load.code } : {}), ...(load.requestId ? { requestId: load.requestId } : {}) }} />
      </>
    );
  }
  return <ItineraryView trip={load.trip} source={load.source} dayIndex={dayIndex} onSelectDay={onSelectDay} mapsKey={mapsKey} {...(onBack ? { onBack } : {})} />;
}

export function ItineraryView({ trip, source, dayIndex, onSelectDay, mapsKey, onBack, initialSelection = null }: {
  trip: Trip;
  source: TripLoad['source'];
  dayIndex: number;
  onSelectDay: (i: number) => void;
  mapsKey: string | null;
  onBack?: () => void;
  initialSelection?: Selection;
}) {
  const idx = Math.min(Math.max(dayIndex, 0), Math.max(trip.days.length - 1, 0));
  const day = trip.days[idx];
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const points = useMemo(() => (day ? mapPoints(day, trip.places) : []), [day, trip.places]);
  const rows = useMemo(() => (day ? timelineRows(day, trip.places) : []), [day, trip.places]);
  const sync = useMemo(() => (day ? syncSelection(selection, day) : null), [selection, day]);
  const attribution = useMemo(() => attributionFor(trip), [trip]);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // R08: selecting on the map opens (scrolls to) the matching item.
  useEffect(() => {
    if (sync?.focusItemKey && selection?.kind === 'place') rowRefs.current.get(sync.focusItemKey)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [sync, selection]);

  const changeDay = (i: number) => { setSelection(null); onSelectDay(i); };
  const selectPlace = useCallback((placeId: string) => setSelection(s => toggleSelection(s, { kind: 'place', placeId })), []);

  return (
    <>
      <ScreenHeader title={trip.title} {...(onBack ? { onBack } : {})} />
      <p className="it-meta">
        <span className="u1-source">{source === 'server' ? 'サーバー保存データ' : 'モックデータ'}（版 {trip.revision}）</span>{' '}
        {trip.constraints.area} / {trip.constraints.startDate}〜{trip.constraints.endDate}
      </p>
      {attribution.hasFixture && <p className="it-fixture" role="note"><strong>FIXTURE</strong> {FIXTURE_NOTICE}</p>}
      {trip.warnings.length > 0 && (
        <ul className="it-warnings" aria-label="注意">{trip.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      )}

      {trip.days.length === 0 || !day ? (
        <div className="u1-empty"><p>この旅程にはまだ日程がありません。</p></div>
      ) : (
        <>
          <div className="it-days" role="tablist" aria-label="日付">
            {trip.days.map((d, i) => (
              <button key={d.date} type="button" role="tab" aria-selected={i === idx} className={`it-day${i === idx ? ' it-on' : ''}`} onClick={() => changeDay(i)}>
                {i + 1}日目 {formatDay(d.date)}
              </button>
            ))}
          </div>
          <section role="tabpanel" aria-label={`${idx + 1}日目`} className="it-layout">
            <p className="it-daymode">
              この日の移動手段：<strong>{DAY_MODE_LABEL[dayTransportMode(trip, day.date)]}</strong>
              <span className="meta">（時刻は各予定の現地時間・{day.timeZone}）</span>
            </p>
            <div className="it-mapcol">
              <MapPanel apiKey={mapsKey} points={points} highlighted={sync?.placeIds ?? NO_PLACES} onSelectPlace={selectPlace} />
              <UnlocatedNote names={unlocatedPlaces(day, trip.places)} />
              <AttributionBlock attribution={attribution} mapShown={mapsKey !== null} />
            </div>
            <ol className="it-timeline" aria-label="行程表">
              {rows.length === 0 && <li className="u1-empty">この日の予定はありません。</li>}
              {rows.map(r => (
                <li key={r.key} ref={el => { if (el) rowRefs.current.set(r.key, el); else rowRefs.current.delete(r.key); }}>
                  <TimelineItem row={r} selected={sync?.itemKeys.has(r.key) ?? false}
                    onSelect={() => setSelection(s => toggleSelection(s, { kind: 'item', key: r.key }))} />
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </>
  );
}

function Unknown({ text }: { text: string }) {
  return text === VALUE_UNKNOWN || text === TIME_UNKNOWN ? <span className="u1-unknown">{text}</span> : <>{text}</>;
}

export function TimelineItem({ row, selected, onSelect }: { row: TimelineRow; selected: boolean; onSelect: () => void }) {
  const { item } = row;
  const nums = row.numbers.length > 0 ? row.numbers.join('→') : null;
  const head = (
    <span className="it-time">
      <Unknown text={row.start} /> 〜 <Unknown text={row.end} />
    </span>
  );
  if (item.type === 'activity') {
    return (
      <button type="button" className={`it-item${selected ? ' it-on' : ''}`} aria-pressed={selected} onClick={onSelect}>
        {head}
        <span className="it-title">
          {nums ? <span className="it-num" aria-label={`地図の地点${nums}`}>{nums}</span> : <span className="it-num it-num-none" aria-label="地図に表示なし">–</span>}
          {row.title}
        </span>
        <span className="meta">
          {KIND_LABEL[item.kind]}{item.fixed ? '・固定予定' : ''}
          {item.kind === 'free_walk' && <>・エリア {item.areaName ?? VALUE_UNKNOWN}</>}
          ・費用 <Unknown text={item.cost === null ? VALUE_UNKNOWN : fareText(item.cost)} />
        </span>
      </button>
    );
  }
  const t = transitDetail(item);
  return (
    <button type="button" className={`it-item it-leg${selected ? ' it-on' : ''}`} aria-pressed={selected} onClick={onSelect}>
      {head}
      <span className="it-title">
        <span className="it-legmode">{LEG_MODE_LABEL[item.mode]}</span>
        {row.title}
      </span>
      <span className="meta">所要 <Unknown text={durationText(item.durationSeconds)} />・運賃 <Unknown text={fareText(item.fare)} /></span>
      {t && (
        <span className="meta it-transit">
          路線 <Unknown text={t.line} />・乗車 <Unknown text={t.boarding} />・降車 <Unknown text={t.alighting} />
          ・乗換 <Unknown text={t.transferCount} />{t.transfers.length > 0 ? `（${t.transfers.join('、')}）` : ''}
          ・ホーム <Unknown text={t.platform} />
        </span>
      )}
    </button>
  );
}

function UnlocatedNote({ names }: { names: { number: number; name: string }[] }) {
  if (names.length === 0) return null;
  return <p className="meta">位置不明のため地図に出せない地点：{names.map(n => `${n.number}. ${n.name}`).join('、')}</p>;
}

/** Display rules of docs/provider-probe.md: Google attribution, third-party credits and photo authors. */
export function AttributionBlock({ attribution, mapShown }: { attribution: ReturnType<typeof attributionFor>; mapShown: boolean }) {
  return (
    <footer className="it-attr" aria-label="出典">
      <p>
        出典：
        {attribution.usesGoogle
          ? mapShown ? '地図・地点・経路データ © Google（Google Maps）' : <><strong className="it-google">Google Maps</strong> の地点・経路データ（地図なし表示）</>
          : mapShown ? '地図 © Google' : '地図なし表示'}
        {attribution.hasFixture ? '／サンプルデータ（fixture）' : ''}
      </p>
      {attribution.providers.length > 0 && <p>提供元：{attribution.providers.join('、')}</p>}
      {attribution.photos.length > 0 && <p>写真：{attribution.photos.join('、')}</p>}
      <p className="meta">地図上の線は訪問順を直線で結んだもので、実際の経路ではありません。</p>
    </footer>
  );
}
