import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, Trip } from '@tkb/contracts';
import { FIXTURE_NOTICE } from '@tkb/fixtures';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { formatDay } from '../../lib/format.ts';
import type { Selection } from '../../lib/places.ts';
import { createMockApi, type MockApi } from '../../mocks/index.ts';
import { createLiveTripEditApi, createMockTripEditApi, describeEditError, isRevisionConflict, type TripEditApi } from '../edit/api.ts';
import { applyOperations } from '../edit/ops.ts';
import { fetchTrip, fetchTripFromMock, type TripLoad } from './api.ts';
import { ItineraryTable } from './ItineraryTable.tsx';
import { MapPanel } from './MapPanel.tsx';
import { readBrowserMapsKey } from './mapsKey.ts';
import {
  DAY_MODE_LABEL, attributionFor, dayTransportMode, mapPoints, syncSelection, toggleSelection, unlocatedPlaces,
} from './model.ts';
import { itineraryHash, type ItineraryRoute } from './route.ts';
import { blockOf, planMoves, tableRows } from './table.ts';
import '../../components/u01.css';
import './itinerary.css';

const NO_PLACES: ReadonlySet<string> = new Set();

/** How a reorder is saved: locally only (an unsaved candidate preview) or through K10 PATCH (mock or server). */
export type ItineraryEditor = { kind: 'local' } | { kind: 'api'; api: TripEditApi };

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
  const editApi = useMemo<TripEditApi>(() => (api ? createMockTripEditApi(api) : createLiveTripEditApi()), [api]);
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
      mapsKey={readBrowserMapsKey()} editor={{ kind: 'api', api: editApi }} {...(onBack ? { onBack } : {})} />
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
export function ItineraryBody({ load, dayIndex, onSelectDay, onRetry, mapsKey, onBack, editor }: {
  load: TripLoad | null;
  dayIndex: number;
  onSelectDay: (i: number) => void;
  onRetry: () => void;
  mapsKey: string | null;
  onBack?: () => void;
  editor?: ItineraryEditor;
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
  return (
    <ItineraryView trip={load.trip} source={load.source} dayIndex={dayIndex} onSelectDay={onSelectDay} mapsKey={mapsKey}
      {...(editor ? { editor } : {})} {...(onBack ? { onBack } : {})} />
  );
}

export function ItineraryView({ trip: tripProp, source, dayIndex, onSelectDay, mapsKey, onBack, initialSelection = null, initialExpanded = [], editor, hideHeader = false, previewNote }: {
  trip: Trip;
  source: TripLoad['source'] | 'preview';
  dayIndex: number;
  onSelectDay: (i: number) => void;
  mapsKey: string | null;
  onBack?: () => void;
  initialSelection?: Selection;
  /** Row keys opened at the start (stay rows show their details and nested activities). */
  initialExpanded?: string[];
  /** Without an editor the table is read-only (no drag handles). */
  editor?: ItineraryEditor;
  hideHeader?: boolean;
  /** Shown instead of the saved-data line, e.g. for an unsaved candidate preview. */
  previewNote?: string;
}) {
  const [trip, setTrip] = useState(tripProp);
  useEffect(() => setTrip(tripProp), [tripProp]);
  const idx = Math.min(Math.max(dayIndex, 0), Math.max(trip.days.length - 1, 0));
  const day = trip.days[idx];
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(initialExpanded));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const points = useMemo(() => (day ? mapPoints(day, trip.places) : []), [day, trip.places]);
  const rows = useMemo(() => (day ? tableRows(day, trip.places) : []), [day, trip.places]);
  const sync = useMemo(() => (day ? syncSelection(selection, day) : null), [selection, day]);
  const attribution = useMemo(() => attributionFor(trip), [trip]);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const editable = editor !== undefined;

  // R08: selecting on the map opens the matching row and scrolls to it.
  useEffect(() => {
    if (sync?.focusItemKey && selection?.kind === 'place') rowRefs.current.get(sync.focusItemKey)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [sync, selection]);

  const changeDay = (i: number) => { setSelection(null); setNotice(null); onSelectDay(i); };
  const toggleOpen = (key: string) => setExpanded(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  // D: clicking a row (or a map marker) shows its details: the row opens and is selected.
  const selectRow = (key: string) => {
    const open = !expanded.has(key);
    toggleOpen(key);
    setSelection(s => (open ? { kind: 'item', key } : toggleSelection(s, { kind: 'item', key })));
  };
  const selectPlace = useCallback((placeId: string) => {
    setSelection(s => toggleSelection(s, { kind: 'place', placeId }));
    const keys = rows.flatMap(r => (r.kind === 'stay' && r.item.placeId === placeId ? [r.key] : []));
    setExpanded(s => new Set([...s, ...keys]));
  }, [rows]);

  const commitMove = async (key: string, before: string | null) => {
    if (!day || !editor) return;
    const order = day.items.map(i => (i.type === 'activity' ? i.activityId : i.legId));
    const ops = planMoves(order, blockOf(day, key), before, idx);
    if (ops.length === 0) return;
    setNotice(null);
    if (editor.kind === 'local') {
      const r = applyOperations(trip, ops);
      if (!r.ok) { setNotice({ kind: 'error', text: `並べ替えできませんでした（${r.reason}）。` }); return; }
      setTrip({ ...r.trip, validationState: 'needs_revalidation' });
      setNotice({ kind: 'info', text: '並べ替えました（候補の表示のみ・まだ保存していません）。移動の時刻は再計算されていません。' });
      return;
    }
    setSaving(true);
    const r = await editor.api.patch(trip.tripId, { expectedRevision: trip.revision, operations: ops });
    setSaving(false);
    if (!r.ok) {
      setNotice({ kind: 'error', text: apiMessage(r.error) });
      return; // nothing is overwritten: the table keeps what is saved
    }
    setTrip(r.data.trip);
    setNotice({ kind: 'info', text: `並べ替えを保存しました（版 ${r.data.revision}）。移動の時刻と所要時間は再計算が必要です。` });
  };

  return (
    <>
      {!hideHeader && <ScreenHeader title={trip.title} {...(onBack ? { onBack } : {})} />}
      <p className="it-meta">
        {previewNote ? <span className="u1-source">{previewNote}</span> : <span className="u1-source">{source === 'server' ? 'サーバー保存データ' : 'モックデータ'}（版 {trip.revision}）</span>}{' '}
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
            <div className="it-tablecol">
              {editable && <p className="meta it-hint">左端の「⠿」をドラッグで並べ替え（キーボードは Enter→↑↓→Enter）。行を押すと詳細。</p>}
              {saving && <p role="status" className="u1-loading">並べ替えを保存中…</p>}
              {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={notice.kind === 'error' ? 'it-notice it-error' : 'it-notice'}>{notice.text}</p>}
              <ItineraryTable key={idx} rows={rows} dayDate={day.date} expanded={expanded} selectedKeys={sync?.itemKeys}
                onToggleRow={selectRow} saving={saving} {...(editable ? { onReorder: (k: string, b: string | null) => void commitMove(k, b) } : {})}
                setRowRef={(k, el) => { if (el) rowRefs.current.set(k, el); else rowRefs.current.delete(k); }} />
            </div>
          </section>
        </>
      )}
    </>
  );
}

function apiMessage(e: ApiError): string {
  return isRevisionConflict(e) ? describeEditError(e) : `保存できませんでした。${describeEditError(e)}`;
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
      <p className="meta">地図上の線は訪問順を直線で結んだもので、実際の経路ではありません。矢印は進む向きです。</p>
    </footer>
  );
}
