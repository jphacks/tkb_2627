import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, Trip } from '@tkb/contracts';
import { FIXTURE_NOTICE } from '@tkb/fixtures';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { UNKNOWN, formatDay, formatMoney } from '../../lib/format.ts';
import type { Selection } from '../../lib/places.ts';
import { createMockApi, type MockApi } from '../../mocks/index.ts';
import { createLiveTripEditApi, createMockTripEditApi, describeEditError, isRevisionConflict, type TripEditApi } from '../edit/api.ts';
import { applyOperations } from '../edit/ops.ts';
import { fetchTrip, fetchTripFromMock, type TripLoad } from './api.ts';
import { MapPanel } from './MapPanel.tsx';
import { readBrowserMapsKey } from './mapsKey.ts';
import {
  DAY_MODE_LABEL, KIND_LABEL, attributionFor, dayTransportMode, mapPoints, syncSelection, toggleSelection, unlocatedPlaces,
} from './model.ts';
import { itineraryHash, type ItineraryRoute } from './route.ts';
import {
  blockOf, childDetails, insertBeforeKey, keyboardTarget, legDetails, planMoves, stayDetails, tableRows,
  type ChildRow, type DetailLine, type LegRow, type StayRow,
} from './table.ts';
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

type Drag = { key: string; before: string | null | undefined; mode: 'pointer' | 'keyboard'; order: string[] };

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
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const points = useMemo(() => (day ? mapPoints(day, trip.places) : []), [day, trip.places]);
  const rows = useMemo(() => (day ? tableRows(day, trip.places) : []), [day, trip.places]);
  const stayKeys = useMemo(() => rows.flatMap(r => (r.kind === 'stay' ? [r.key] : [])), [rows]);
  const sync = useMemo(() => (day ? syncSelection(selection, day) : null), [selection, day]);
  const attribution = useMemo(() => attributionFor(trip), [trip]);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const editable = editor !== undefined;

  // R08: selecting on the map opens the matching row and scrolls to it.
  useEffect(() => {
    if (sync?.focusItemKey && selection?.kind === 'place') rowRefs.current.get(sync.focusItemKey)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [sync, selection]);

  const changeDay = (i: number) => { setSelection(null); setDrag(null); setNotice(null); onSelectDay(i); };
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

  // R1: pointer based drag (mouse and touch) from the handle.
  const dropFromPoint = (e: React.PointerEvent, d: Drag): Drag => {
    const el = document.elementFromPoint?.(e.clientX, e.clientY)?.closest?.('[data-stay-key]') as HTMLElement | null;
    const overKey = el?.dataset.stayKey;
    if (!el || !overKey) return d;
    const rect = el.getBoundingClientRect();
    const after = el.dataset.detail === '1' || e.clientY > rect.top + rect.height / 2;
    return { ...d, before: insertBeforeKey(stayKeys, d.key, overKey, after) };
  };
  const onHandlePointerDown = (e: React.PointerEvent, key: string) => {
    if (saving || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ key, before: undefined, mode: 'pointer', order: stayKeys });
  };
  const onHandlePointerMove = (e: React.PointerEvent) => {
    if (drag?.mode === 'pointer') setDrag(dropFromPoint(e, drag));
  };
  const onHandlePointerUp = (e: React.PointerEvent) => {
    if (drag?.mode !== 'pointer') return;
    const final = dropFromPoint(e, drag);
    setDrag(null);
    if (final.before !== undefined) void commitMove(final.key, final.before);
  };
  // Keyboard alternative: Enter/Space picks the row up, arrow keys move it, Enter/Space drops, Escape cancels.
  const onHandleKeyDown = (e: React.KeyboardEvent, key: string) => {
    if (saving) return;
    if (!drag || drag.mode !== 'keyboard' || drag.key !== key) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrag({ key, before: undefined, mode: 'keyboard', order: stayKeys }); }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const before = keyboardTarget(drag.order, key, dir);
      if (before === undefined) return;
      const order = drag.order.filter(k => k !== key);
      order.splice(before === null ? order.length : order.indexOf(before), 0, key);
      setDrag({ ...drag, before, order });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const final = drag;
      setDrag(null);
      if (final.before !== undefined) void commitMove(final.key, final.before);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDrag(null);
    }
  };

  const dragTitle = drag ? rows.find(r => r.key === drag.key && r.kind === 'stay')?.key : null;
  const dragName = dragTitle ? (rows.find(r => r.key === dragTitle) as StayRow).item.title : '';

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
              {editable && <p className="meta it-hint">左の「⠿」をドラッグ（またはEnterで持ち上げて↑↓キー、Enterで置く）で並べ替えられます。行を押すと詳細が開きます。</p>}
              <p className="u1-sr" role="status" aria-live="polite">
                {drag ? `「${dragName}」を移動中。${drag.before === undefined ? '移動先を選んでください。' : drag.before === null ? '最後に置きます。' : `「${(rows.find(r => r.key === drag.before) as StayRow | undefined)?.item.title ?? ''}」の前に置きます。`}` : ''}
              </p>
              {saving && <p role="status" className="u1-loading">並べ替えを保存中…</p>}
              {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={notice.kind === 'error' ? 'it-notice it-error' : 'it-notice'}>{notice.text}</p>}
              <table className="it-table" aria-label="行程表">
                <thead><tr><th scope="col" className="it-col-time">時刻</th><th scope="col">内容</th></tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={2} className="u1-empty">この日の予定はありません。</td></tr>}
                  {rows.map(r => (
                    <Fragment key={r.key}>
                      {r.kind === 'stay' ? (
                        <StayTableRows row={r} open={expanded.has(r.key)} selected={sync?.itemKeys.has(r.key) ?? false} editable={editable}
                          dragging={drag?.key === r.key} dropBefore={drag !== null && drag.before === r.key} dayDate={day.date}
                          setRef={el => { if (el) rowRefs.current.set(r.key, el); else rowRefs.current.delete(r.key); }}
                          onToggle={() => selectRow(r.key)}
                          onHandlePointerDown={e => onHandlePointerDown(e, r.key)} onHandlePointerMove={onHandlePointerMove}
                          onHandlePointerUp={onHandlePointerUp} onHandleCancel={() => setDrag(null)} onHandleKeyDown={e => onHandleKeyDown(e, r.key)} />
                      ) : (
                        <LegTableRows row={r} open={expanded.has(r.key)} selected={sync?.itemKeys.has(r.key) ?? false} dayDate={day.date} onToggle={() => selectRow(r.key)} />
                      )}
                    </Fragment>
                  ))}
                  {drag !== null && drag.before === null && <tr className="it-drop-end" aria-hidden="true"><td colSpan={2}>ここに置く</td></tr>}
                </tbody>
              </table>
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

function Unknown({ text }: { text: string }) {
  return text === UNKNOWN ? <span className="u1-unknown">{text}</span> : <>{text}</>;
}

/** Time text such as 「9:00〜10:00」 with any 未取得 part marked. */
function TimeText({ text }: { text: string }) {
  return text.includes(UNKNOWN) ? <>{text.split(UNKNOWN).flatMap((part, i, a) => (i < a.length - 1 ? [part, <span key={i} className="u1-unknown">{UNKNOWN}</span>] : [part]))}</> : <>{text}</>;
}

function DetailList({ lines, label }: { lines: DetailLine[]; label: string }) {
  return (
    <dl className="it-dl" aria-label={label}>
      {lines.map(l => (
        <Fragment key={l.label}>
          <dt>{l.label}</dt>
          <dd>{l.unknown ? <span className="u1-unknown">{l.value}</span> : l.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function StayTableRows({ row, open, selected, editable, dragging, dropBefore, dayDate, setRef, onToggle, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp, onHandleCancel, onHandleKeyDown }: {
  row: StayRow;
  open: boolean;
  selected: boolean;
  editable: boolean;
  dragging: boolean;
  dropBefore: boolean;
  dayDate: string;
  setRef: (el: HTMLTableRowElement | null) => void;
  onToggle: () => void;
  onHandlePointerDown: (e: React.PointerEvent) => void;
  onHandlePointerMove: (e: React.PointerEvent) => void;
  onHandlePointerUp: (e: React.PointerEvent) => void;
  onHandleCancel: () => void;
  onHandleKeyDown: (e: React.KeyboardEvent) => void;
}) {
  void dayDate;
  const a = row.item;
  const detailId = `it-d-${row.key}`;
  return (
    <>
      <tr ref={setRef} data-stay-key={row.key} className={`it-stay${selected ? ' it-on' : ''}${dragging ? ' it-dragging' : ''}${dropBefore ? ' it-drop-before' : ''}`}>
        <th scope="row" className="it-time"><TimeText text={row.range} /></th>
        <td>
          <div className="it-cell">
            {editable && (
              <button type="button" className="it-handle" aria-label={`「${a.title}」を並べ替える`} aria-pressed={dragging}
                onPointerDown={onHandlePointerDown} onPointerMove={onHandlePointerMove} onPointerUp={onHandlePointerUp}
                onPointerCancel={onHandleCancel} onKeyDown={onHandleKeyDown}>⠿</button>
            )}
            <button type="button" className="it-rowbtn" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
              {row.number !== null
                ? <span className="it-num" aria-label={`地図の地点${row.number}`}>{row.number}</span>
                : <span className="it-num it-num-none" aria-label="地図に表示なし">–</span>}
              <span className="it-rowtext">
                <span className="it-title">{a.title}</span>
                <span className="meta">
                  {KIND_LABEL[a.kind]}{a.fixed ? '・固定予定' : ''}
                  ・費用 <Unknown text={a.cost === null ? UNKNOWN : formatMoney(a.cost)} />
                  {row.children.length > 0 ? `・中の予定 ${row.children.length}件` : ''}
                </span>
              </span>
              <span className="it-chev" aria-hidden="true">{open ? '▲' : '▼'}</span>
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr id={detailId} className="it-detail" data-stay-key={row.key} data-detail="1">
          <td colSpan={2}>
            <DetailList lines={stayDetails(row)} label={`${a.title}の詳細`} />
            {row.children.length > 0 && (
              <table className="it-subtable" aria-label={`${a.title}の中の予定（時間順）`}>
                <thead><tr><th scope="col" className="it-col-time">時刻</th><th scope="col">内容</th></tr></thead>
                <tbody>{row.children.map(c => <ChildTableRow key={c.key} child={c} />)}</tbody>
              </table>
            )}
            {row.children.length === 0 && <p className="meta">この予定の中の細かい予定はありません（取得できていない場合も、作らずにそのままにしています）。</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function ChildTableRow({ child }: { child: ChildRow }) {
  return (
    <tr className="it-child">
      <th scope="row" className="it-time"><TimeText text={child.range} /></th>
      <td>
        <span className="it-title">{child.item.title}</span>
        <DetailList lines={childDetails(child).filter(l => l.label !== '時間')} label={`${child.item.title}の詳細`} />
      </td>
    </tr>
  );
}

/** A travel leg is two thin rows: the start row (departure time) and the end row (arrival time). */
function LegTableRows({ row, open, selected, dayDate, onToggle }: { row: LegRow; open: boolean; selected: boolean; dayDate: string; onToggle: () => void }) {
  const detailId = `it-d-${row.key}`;
  const cls = `it-conn${selected ? ' it-on' : ''}${row.stale ? ' it-stale' : ''}`;
  return (
    <>
      <tr className={`${cls} it-conn-start`} data-leg-key={row.key}>
        <th scope="row" className="it-time"><span className="it-tm">出発 </span><TimeText text={row.departure} /></th>
        <td>
          <button type="button" className="it-connbtn" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
            <span aria-hidden="true">↓</span> {row.fromName}から <span className="it-legmode">{row.summary}</span>
            {row.stale && <span className="it-stale-tag">要再計算</span>}
          </button>
        </td>
      </tr>
      <tr className={`${cls} it-conn-end`} data-leg-key={row.key}>
        <th scope="row" className="it-time"><span className="it-tm">到着 </span><TimeText text={row.arrival} /></th>
        <td className="meta">{row.toName}へ</td>
      </tr>
      {open && (
        <tr id={detailId} className="it-detail" data-detail-leg="1">
          <td colSpan={2}><DetailList lines={legDetails(row, dayDate)} label={`${row.fromName}から${row.toName}への移動の詳細`} /></td>
        </tr>
      )}
    </>
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
      <p className="meta">地図上の線は訪問順を直線で結んだもので、実際の経路ではありません。矢印は進む向きです。</p>
    </footer>
  );
}
