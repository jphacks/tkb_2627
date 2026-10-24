import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { AlternativeCandidate, AlternativesResult, ApiError, Trip, TripOperation, TripPatchResult } from '@tkb/contracts';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { formatDay } from '../../lib/format.ts';
import { TIME_UNKNOWN } from '../itinerary/model.ts';
import { ItineraryTable } from '../itinerary/ItineraryTable.tsx';
import { tableRows } from '../itinerary/table.ts';
import { createLiveTripEditApi, createMockTripEditApi, type TripEditApi } from './api.ts';
import { DiffView, EditError, NO_OPERATIONS_REASON, TRAVEL_LABEL } from './DiffView.tsx';
import { applyOperations, itemIdOf, newFreeActivity, reorderOps, titleLookup } from './ops.ts';
import { describeOp, initialPending, pendingReducer } from './pending.ts';
import { tripScreenHash, type TripScreenRoute } from './route.ts';
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
  const rows = useMemo(() => (day ? tableRows(day, p.working.places) : []), [day, p.working.places]);

  // R1: a drag becomes K10 `move` operations on the pending list (a stay moves together with its children).
  const reorder = (key: string, before: string | null) => {
    for (const op of reorderOps(p.working, idx, key, before)) p.onAdd(op);
  };

  return (
    <>
      <ScreenHeader title={`${p.trip.title} を編集`} />
      <p className="it-meta">版 {p.trip.revision}（保存はこの版が最新の場合だけ成功します）</p>
      <nav className="ed-links" aria-label="関連画面">
        <a href={tripScreenHash(p.route, 'map')}>地図と旅程</a>
        <a href={tripScreenHash(p.route, 'travel')}>旅行中の画面</a>
      </nav>
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
          <button key={d.date} type="button" role="tab" aria-selected={i === idx} className={`it-day${i === idx ? ' it-on' : ''}`} onClick={() => p.onDay(i)}>
            {i + 1}日目 {formatDay(d.date)}
          </button>
        ))}
      </div>
      {day ? (
        <>
          <p className="ed-note">左の「⠿」をドラッグ（またはEnterで持ち上げて↑↓キー、Enterで置く）で並べ替えられます。行を押すと詳細が開きます。並べ替えは「未保存の編集」に入り、保存するまで確定しません。</p>
          <ItineraryTable key={idx} rows={rows} dayDate={day.date} expanded={expanded} onToggleRow={toggleRow} onReorder={reorder}
            stayBadge={r => (baseIds.has(r.key) ? null : <span className="ed-flag">未保存</span>)}
            stayExtra={r => (
              <button type="button" className="btn" onClick={() => {
                for (const c of r.children) p.onRemove(c.key);
                p.onRemove(r.key);
              }} aria-label={`${r.item.title} を削除`}>削除</button>
            )} />
          <AddForm key={idx} day={day} dayIndex={idx} onAdd={p.onAdd} />
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

function titleLookupMerged(trip: Trip, fallback: (id: string) => string): (id: string) => string {
  const own = titleLookup(trip);
  return id => (own(id) !== id ? own(id) : fallback(id));
}

/** Container: loads the trip by id (a reload shows what the server saved) and owns the pending list. */
export function EditScreen({ route, api: apiProp, onBack }: { route: TripScreenRoute; api?: TripEditApi; onBack?: () => void }) {
  const api = useMemo(() => apiProp ?? (route.mode === 'mock' ? createMockTripEditApi() : createLiveTripEditApi()), [apiProp, route.mode]);
  const [load, setLoad] = useState<{ state: 'loading' } | { state: 'ok'; trip: Trip } | { state: 'error'; error: ApiError }>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [pending, dispatch] = useReducer(pendingReducer, initialPending);
  const [dayIndex, setDayIndex] = useState(0);
  const [alt, setAlt] = useState<AltState>({ state: 'idle' });
  const [saved, setSaved] = useState<TripPatchResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    void api.getTrip(route.tripId).then(r => { if (live) setLoad(r.ok ? { state: 'ok', trip: r.data } : { state: 'error', error: r.error }); });
    return () => { live = false; };
  }, [api, route.tripId, attempt]);

  const trip = load.state === 'ok' ? load.trip : null;
  const working = useMemo(() => {
    if (!trip) return null;
    const r = applyOperations(trip, pending.ops);
    return r.ok ? r.trip : trip;
  }, [trip, pending.ops]);

  const push = useCallback((op: TripOperation) => { dispatch({ type: 'push', op }); setAlt({ state: 'idle' }); setSaved(null); }, []);
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
      />
    </Shell>
  );
}

function Shell({ route, children }: { route: TripScreenRoute; children: React.ReactNode }) {
  return (
    <div className="u1-root">
      {route.mode === 'mock' && <MockBanner />}
      <main className="u1-main" aria-label="旅程の編集">{children}</main>
    </div>
  );
}
