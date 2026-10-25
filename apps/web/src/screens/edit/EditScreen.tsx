import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { AlternativeCandidate, AlternativesResult, ApiError, Trip, TripOperation, TripPatchResult } from '@tkb/contracts';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { formatDay } from '../../lib/format.ts';
import { TIME_UNKNOWN } from '../itinerary/model.ts';
import type { Selection } from '../../lib/places.ts';
import { AttributionBlock } from '../itinerary/ItineraryScreen.tsx';
import { ItineraryTable, type InsertPosition } from '../itinerary/ItineraryTable.tsx';
import { InsertSlot } from '../itinerary/InsertSlot.tsx';
import { MapPanel } from '../itinerary/MapPanel.tsx';
import { readBrowserMapsKey } from '../itinerary/mapsKey.ts';
import { attributionFor, mapPoints, syncSelection, toggleSelection, unlocatedPlaces } from '../itinerary/model.ts';
import { opsToDay, recalcDay } from '../itinerary/recalc.ts';
import { blockOf, planMoves, tableRows } from '../itinerary/table.ts';
import { createLiveTripEditApi, createMockTripEditApi, sharedMockApi, type TripEditApi } from './api.ts';
import { DiffView, EditError, NO_OPERATIONS_REASON, TRAVEL_LABEL } from './DiffView.tsx';
import { applyOperations, itemIdOf, newFreeActivity, reorderOps, titleLookup } from './ops.ts';
import { describeOp, initialPending, pendingReducer } from './pending.ts';
import type { TripScreenRoute } from './route.ts';
import '../../components/u01.css';
import './edit.css';

export type AltState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; result: AlternativesResult }
  | { state: 'error'; error: ApiError };

export interface EditViewProps {
  trip: Trip;
  /** The trip with the pending (unsaved) operations applied locally. */
  working: Trip;
  pending: readonly TripOperation[];
  dayIndex: number;
  onDay: (i: number) => void;
  onAdd: (op: TripOperation) => void;
  onRemove: (itemId: string) => void;
  onUndo: () => void;
  onClear: () => void;
  onPreview: () => void;
  alt: AltState;
  onApply: (c: AlternativeCandidate) => void;
  saved: TripPatchResult | null;
  error: ApiError | null;
  onReload: () => void;
  onDismissError: () => void;
  busy: boolean;
  route: TripScreenRoute;
  /** Browser Maps key (null: the map falls back to the drawn plan without tiles). */
  mapsKey?: string | null;
  /**
   * U11: with no unsaved edits a drag is saved at once (K10 PATCH with expectedRevision). Without it, or with unsaved
   * edits, the drag goes to the pending list like the other edits.
   */
  onSaveMove?: (dayIndex: number, key: string, before: string | null) => void;
  /** Result line of the last saved drag. */
  moveNotice?: string | null;
}

const NO_PLACES: ReadonlySet<string> = new Set();

/**
 * K10 operations that save a drag: the stay (with its children) moved before `before`, then the day re-timed with the
 * known legs (the same as the map screen did), so no stay keeps the time of its old place. Empty when nothing changes.
 */
export function moveSaveOps(trip: Trip, dayIndex: number, key: string, before: string | null): TripOperation[] {
  const day = trip.days[dayIndex];
  if (!day) return [];
  const moves = planMoves(day.items.map(itemIdOf), blockOf(day, key), before, dayIndex);
  if (moves.length === 0) return [];
  const moved = applyOperations(trip, moves);
  if (!moved.ok) return [];
  const stayOrder = (d: Trip['days'][number]) => d.items.flatMap(i => (i.type === 'activity' && !i.parentActivityId ? [i.activityId] : []));
  if (stayOrder(moved.trip.days[dayIndex]!).join('|') === stayOrder(day).join('|')) return [];
  const next = recalcDay(moved.trip, dayIndex).trip.days[dayIndex];
  return next ? opsToDay(day, next, dayIndex) : moves;
}

/** Candidate card: kind, summary, diff (R11), affected segments and an apply button that explains why it is disabled. */
export function AlternativeCard({ c, titleOf, onApply, busy }: { c: AlternativeCandidate; titleOf: (id: string) => string; onApply: (c: AlternativeCandidate) => void; busy: boolean }) {
  const kind = c.kind === 'requested' ? '指定どおり' : c.kind === 'reorder' ? '並べ替え' : '代替地点';
  const reasonId = `ed-why-${c.candidateId}`;
  return (
    <li className="ed-cand">
      <p className="ed-title"><span className="ed-flag">{kind}</span>{c.summary}</p>
      <DiffView diff={c.diff} titleOf={titleOf} />
      {c.displayOnly && <p className="ed-note">表示のみの参考値（経路詳細を含む）がありますが、保存される差分は上のとおりです。</p>}
      {c.affectedSegments.length > 0 && (
        <ul className="ed-note" aria-label="影響する区間">
          {c.affectedSegments.map(s => (
            <li key={`${s.fromItemId}-${s.toItemId}`} className={s.travel === 'unknown' ? 'u1-unknown' : undefined}>
              {s.dayIndex + 1}日目 {titleOf(s.fromItemId)} → {titleOf(s.toItemId)}: {TRAVEL_LABEL[s.travel]}
            </li>
          ))}
        </ul>
      )}
      {c.unknown.length > 0 && <p className="ed-note u1-unknown">不明: {c.unknown.join('、')}</p>}
      {c.warnings.map(w => <p key={w} className="ed-note">注意: {w}</p>)}
      <button type="button" className="btn u1-primary" disabled={busy || c.operations === null} aria-describedby={c.operations === null ? reasonId : undefined}
        onClick={() => onApply(c)}>この案を保存する</button>
      {c.operations === null && <p id={reasonId} className="ed-note">{NO_OPERATIONS_REASON}</p>}
    </li>
  );
}

function AddForm({ day, dayIndex, onAdd }: { day: Trip['days'][number]; dayIndex: number; onAdd: (op: TripOperation) => void }) {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const a = newFreeActivity({ title, date: day.date, timeZone: day.timeZone, startText: start, endText: end });
    if ('error' in a) { setErr(a.error); return; }
    setErr(null);
    onAdd({ op: 'add', dayIndex, position: day.items.length, item: a });
    setTitle(''); setStart(''); setEnd('');
  };
  return (
    <form className="ed-form" onSubmit={e => { e.preventDefault(); submit(); }} aria-label="予定を追加">
      <strong>自由な予定を追加（この日の最後）</strong>
      <label>タイトル<input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required /></label>
      <div className="ed-times">
        <label>開始（任意・{day.timeZone}）<input value={start} onChange={e => setStart(e.target.value)} inputMode="numeric" placeholder="10:00" /></label>
        <label>終了（任意）<input value={end} onChange={e => setEnd(e.target.value)} inputMode="numeric" placeholder="11:30" /></label>
      </div>
      <p className="ed-note">時刻を入れない場合は「{TIME_UNKNOWN}」のまま追加します。費用は不明として追加します。</p>
      {err && <p role="alert" className="u1-unknown">{err}</p>}
      <button type="submit" className="btn">予定を追加リストに入れる</button>
    </form>
  );
}

/** Presentational edit screen (no fetching), rendered directly in tests. */
export function EditView(p: EditViewProps) {
  const titleOf = useMemo(() => titleLookup(p.working), [p.working]);
  const baseTitleOf = useMemo(() => titleLookup(p.trip), [p.trip]);
  const idx = Math.min(Math.max(p.dayIndex, 0), Math.max(p.working.days.length - 1, 0));
  const day = p.working.days[idx];
  const baseIds = useMemo(() => new Set(p.trip.days.flatMap(d => d.items.map(itemIdOf))), [p.trip]);
  const lookupAll = (id: string) => (baseTitleOf(id) !== id ? baseTitleOf(id) : titleOf(id));

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleRow = (key: string) => setExpanded(x => { const n = new Set(x); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // Shown with the times re-computed for the current order, so a moved stay never keeps its old time (UI review on #32).
  // Display only: the saved times come from the candidate preview (K10 alternatives), as before.
  const shownDay = useMemo(() => (day ? recalcDay(p.working, idx).trip.days[idx] ?? day : null), [day, p.working, idx]);
  const rows = useMemo(() => (shownDay ? tableRows(shownDay, p.working.places) : []), [shownDay, p.working.places]);

  // U11 (U04 + U06 on one tab): the map above the table, with the same numbers; a row selects its map point and a map
  // point selects (and opens) its rows.
  const [selection, setSelection] = useState<Selection>(null);
  const points = useMemo(() => (shownDay ? mapPoints(shownDay, p.working.places) : []), [shownDay, p.working.places]);
  const sync = useMemo(() => (shownDay ? syncSelection(selection, shownDay) : null), [selection, shownDay]);
  const attribution = useMemo(() => attributionFor(p.working), [p.working]);
  const selectRow = (key: string) => {
    const open = !expanded.has(key);
    toggleRow(key);
    setSelection(s => (open ? { kind: 'item', key } : toggleSelection(s, { kind: 'item', key })));
  };
  const selectPlace = (placeId: string) => {
    setSelection(s => toggleSelection(s, { kind: 'place', placeId }));
    const keys = rows.flatMap(r => (r.kind === 'stay' && r.item.placeId === placeId ? [r.key] : []));
    setExpanded(s => new Set([...s, ...keys]));
  };
  const changeDay = (i: number) => { setSelection(null); p.onDay(i); };

  // R1: a drag is saved at once when nothing else is unsaved (U11); otherwise it becomes K10 `move` operations on the
  // pending list (a stay moves together with its children).
  const reorder = (key: string, before: string | null) => {
    if (p.onSaveMove && p.pending.length === 0) { p.onSaveMove(idx, key, before); return; }
    for (const op of reorderOps(p.working, idx, key, before)) p.onAdd(op);
  };

  // U11: M3's insert UI (InsertSlot) adds a free item at the slot's place (K10 add on the pending list).
  const insertAt = (beforeKey: string | null, item: { title: string; start?: string; end?: string }) => {
    if (!day) return;
    const a = newFreeActivity({ title: item.title, date: day.date, timeZone: day.timeZone, startText: item.start ?? '', endText: item.end ?? '' });
    if ('error' in a) return;
    const at = beforeKey === null ? -1 : day.items.findIndex(i => itemIdOf(i) === beforeKey);
    p.onAdd({ op: 'add', dayIndex: idx, position: at < 0 ? day.items.length : at, item: a });
  };
  const slot = (position: InsertPosition, beforeKey: string | null) => (
    <InsertSlot position={position} disabled={p.busy} onAdd={item => insertAt(beforeKey, item)} />
  );

  return (
    <>
      <ScreenHeader title={p.trip.title} />
      <p className="it-meta">版 {p.trip.revision}（保存はこの版が最新の場合だけ成功します）</p>
      {p.error && <EditError error={p.error} onReload={p.onReload} onDismiss={p.onDismissError} />}
      {p.saved && (
        <section role="status" className="ed-cand" aria-label="保存結果">
          <strong>保存しました（版 {p.saved.revision}）</strong>
          <DiffView diff={p.saved.diff} titleOf={lookupAll} heading="保存した変更の差分" />
          {p.saved.warnings.map(w => <p key={w} className="ed-note">注意: {w}</p>)}
        </section>
      )}
      <div className="it-days" role="tablist" aria-label="日付">
        {p.working.days.map((d, i) => (
          <button key={d.date} type="button" role="tab" aria-selected={i === idx} className={`it-day${i === idx ? ' it-on' : ''}`} onClick={() => changeDay(i)}>
            {i + 1}日目 {formatDay(d.date)}
          </button>
        ))}
      </div>
      {day && shownDay ? (
        <>
          <div className="it-mapcol">
            <MapPanel apiKey={p.mapsKey ?? null} points={points} highlighted={sync?.placeIds ?? NO_PLACES} onSelectPlace={selectPlace} />
            <UnlocatedNote names={unlocatedPlaces(shownDay, p.working.places)} />
            <AttributionBlock attribution={attribution} mapShown={(p.mapsKey ?? null) !== null} />
          </div>
          {p.moveNotice && <p role="status" className="it-notice">{p.moveNotice}</p>}
          {/* The how-to is read out only (UI review on #32: no hint text on screen). */}
          <p className="u1-sr">左端の「⠿」をドラッグで並べ替え。キーボードは Enter で持ち上げ、上下の矢印キーで動かし、Enter で置きます。行を押すと詳細が開きます。並べ替えは「未保存の編集」に入り、保存するまで確定しません。</p>
          <ItineraryTable key={`table-${idx}`} rows={rows} dayDate={day.date} expanded={expanded} selectedKeys={sync?.itemKeys} onToggleRow={selectRow} onReorder={reorder}
            saving={p.busy} insertSlot={slot}
            stayBadge={r => (baseIds.has(r.key) ? null : <span className="ed-flag">未保存</span>)}
            stayExtra={r => (
              <button type="button" className="btn" onClick={() => {
                for (const c of r.children) p.onRemove(c.key);
                p.onRemove(r.key);
              }} aria-label={`${r.item.title} を削除`}>削除</button>
            )} />
          <AddForm key={`add-${idx}`} day={day} dayIndex={idx} onAdd={p.onAdd} />
        </>
      ) : <p className="u1-empty">日程がありません。</p>}

      <section aria-label="未保存の編集">
        <h2 className="u1-sub">未保存の編集（{p.pending.length}件）</h2>
        {p.pending.length === 0 ? <p className="ed-note">まだ編集していません。</p> : (
          <ol className="ed-pending">{p.pending.map((op, i) => <li key={i}>{describeOp(op, lookupAll)}</li>)}</ol>
        )}
        <div className="ed-bar">
          <button type="button" className="btn" disabled={p.pending.length === 0} onClick={p.onUndo}>直前の編集を取り消す</button>
          <button type="button" className="btn" disabled={p.pending.length === 0} onClick={p.onClear}>すべて破棄</button>
          <button type="button" className="btn u1-primary" disabled={p.pending.length === 0 || p.busy} onClick={p.onPreview}>候補と差分を確認</button>
        </div>
      </section>

      <section aria-label="候補" aria-live="polite">
        {p.alt.state === 'loading' && <p className="u1-loading" role="status">候補を計算中…（何も保存されません）</p>}
        {p.alt.state === 'error' && (!p.error ? <EditError error={p.alt.error} onReload={p.onReload} /> : null)}
        {p.alt.state === 'ok' && (
          <>
            <h2 className="u1-sub">候補（版 {p.alt.result.baseRevision} が基準・まだ保存されていません）</h2>
            {p.alt.result.candidates.length === 0 && <p className="u1-empty">候補がありませんでした。</p>}
            <ul className="ed-list">
              {p.alt.result.candidates.map(c => (
                <AlternativeCard key={c.candidateId} c={c} titleOf={c.trip ? titleLookupMerged(c.trip, lookupAll) : lookupAll} onApply={p.onApply} busy={p.busy} />
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

function UnlocatedNote({ names }: { names: { number: number; name: string }[] }) {
  if (names.length === 0) return null;
  return <p className="meta">位置不明のため地図に出せない地点：{names.map(n => `${n.number}. ${n.name}`).join('、')}</p>;
}

function titleLookupMerged(trip: Trip, fallback: (id: string) => string): (id: string) => string {
  const own = titleLookup(trip);
  return id => (own(id) !== id ? own(id) : fallback(id));
}

/** Container: loads the trip by id (a reload shows what the server saved) and owns the pending list. */
export function EditScreen({ route, api: apiProp, onBack }: { route: TripScreenRoute; api?: TripEditApi; onBack?: () => void }) {
  const api = useMemo(() => apiProp ?? (route.mode === 'mock' ? createMockTripEditApi(sharedMockApi()) : createLiveTripEditApi()), [apiProp, route.mode]);
  const [load, setLoad] = useState<{ state: 'loading' } | { state: 'ok'; trip: Trip } | { state: 'error'; error: ApiError }>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [pending, dispatch] = useReducer(pendingReducer, initialPending);
  const [dayIndex, setDayIndex] = useState(0);
  const [alt, setAlt] = useState<AltState>({ state: 'idle' });
  const [saved, setSaved] = useState<TripPatchResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [moveNotice, setMoveNotice] = useState<string | null>(null);
  /** The trip with a drag that is being saved, shown until the server answers (an error puts the saved order back). */
  const [optimistic, setOptimistic] = useState<Trip | null>(null);
  const mapsKey = useMemo(() => readBrowserMapsKey(), []);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    void api.getTrip(route.tripId).then(r => { if (live) setLoad(r.ok ? { state: 'ok', trip: r.data } : { state: 'error', error: r.error }); });
    return () => { live = false; };
  }, [api, route.tripId, attempt]);

  const trip = load.state === 'ok' ? load.trip : null;
  const working = useMemo(() => {
    if (!trip) return null;
    if (optimistic) return optimistic;
    const r = applyOperations(trip, pending.ops);
    return r.ok ? r.trip : trip;
  }, [trip, pending.ops, optimistic]);

  const push = useCallback((op: TripOperation) => { dispatch({ type: 'push', op }); setAlt({ state: 'idle' }); setSaved(null); setMoveNotice(null); }, []);
  const reload = useCallback(() => {
    // A conflict or a failed save never overwrites: drop the stale pending list and re-read the saved trip.
    dispatch({ type: 'clear' }); setAlt({ state: 'idle' }); setError(null); setSaved(null); setAttempt(a => a + 1);
  }, []);

  if (load.state === 'loading' || !trip || !working) {
    return (
      <Shell route={route}>
        <ScreenHeader title="旅程を編集" {...(onBack ? { onBack } : {})} />
        {load.state === 'error'
          ? <ErrorBox title="旅程を読み込めませんでした" error={load.error} onRetry={() => setAttempt(a => a + 1)} />
          : <p className="u1-loading" role="status">サーバーから旅程を読み込み中…</p>}
      </Shell>
    );
  }

  const preview = async () => {
    setBusy(true); setError(null); setAlt({ state: 'loading' });
    const r = await api.alternatives(route.tripId, { expectedRevision: trip.revision, operations: pending.ops });
    setBusy(false);
    if (r.ok) setAlt({ state: 'ok', result: r.data });
    else { setAlt({ state: 'error', error: r.error }); setError(r.error); }
  };
  // U11: a drag with nothing else unsaved is saved at once (K10 PATCH, expectedRevision = the shown version; 409 shows
  // the conflict message and never overwrites).
  const saveMove = async (dayIdx: number, key: string, before: string | null) => {
    const ops = moveSaveOps(trip, dayIdx, key, before);
    if (ops.length === 0) return;
    const shown = applyOperations(trip, ops);
    if (shown.ok) setOptimistic(shown.trip);
    setBusy(true); setError(null); setSaved(null); setMoveNotice(null); setAlt({ state: 'idle' });
    const r = await api.patch(route.tripId, { expectedRevision: trip.revision, operations: ops });
    setBusy(false);
    setOptimistic(null);
    if (r.ok) {
      setLoad({ state: 'ok', trip: r.data.trip });
      setMoveNotice(`並べ替えを保存しました（版 ${r.data.revision}）。時刻は分かっている移動時間で計算し直しています。`);
    } else setError(r.error);
  };
  const apply = async (c: AlternativeCandidate) => {
    if (c.operations === null || alt.state !== 'ok') return;
    setBusy(true); setError(null);
    const r = await api.patch(route.tripId, { expectedRevision: alt.result.baseRevision, operations: c.operations });
    setBusy(false);
    if (r.ok) {
      setLoad({ state: 'ok', trip: r.data.trip }); dispatch({ type: 'clear' }); setAlt({ state: 'idle' }); setSaved(r.data);
    } else setError(r.error);
  };

  return (
    <Shell route={route}>
      <EditView
        trip={trip} working={working} pending={pending.ops} dayIndex={dayIndex} onDay={setDayIndex}
        onAdd={push}
        onRemove={id => push({ op: 'remove', itemId: id })}
        onUndo={() => { dispatch({ type: 'undo' }); setAlt({ state: 'idle' }); }}
        onClear={() => { dispatch({ type: 'clear' }); setAlt({ state: 'idle' }); }}
        onPreview={() => void preview()} alt={alt} onApply={c => void apply(c)}
        saved={saved} error={error} onReload={reload} onDismissError={() => setError(null)} busy={busy} route={route}
        mapsKey={mapsKey} onSaveMove={(d, k, b) => void saveMove(d, k, b)} moveNotice={moveNotice}
      />
    </Shell>
  );
}

function Shell({ route, children }: { route: TripScreenRoute; children: React.ReactNode }) {
  return (
    <div className="u1-root">
      {route.mode === 'mock' && <MockBanner />}
      <main className="u1-main" aria-label="地図と旅程の編集">{children}</main>
    </div>
  );
}
