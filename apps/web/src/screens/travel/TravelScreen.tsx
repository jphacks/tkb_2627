import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiError, ReplanCandidate, ReplanConflictReason, ReplanResult, Trip, TripPatchResult } from '@tkb/contracts';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { formatDay } from '../../lib/format.ts';
import { createLiveTripEditApi, createMockTripEditApi, type TripEditApi } from '../edit/api.ts';
import { DiffView, EditError, NO_OPERATIONS_REASON } from '../edit/DiffView.tsx';
import { titleLookup } from '../edit/ops.ts';
import { tripScreenHash, type TripScreenRoute } from '../edit/route.ts';
import { LEG_MODE_LABEL, VALUE_UNKNOWN, durationText, fareText } from '../itinerary/model.ts';
import { ItineraryTable } from '../itinerary/ItineraryTable.tsx';
import { tableRows } from '../itinerary/table.ts';
import { SKIPPED, buildReplanRequest, requestLocation, type GeoLike } from './geo.ts';
import '../../components/u01.css';
import '../edit/edit.css';

export const CONFLICT_LABEL: Record<ReplanConflictReason, string> = {
  missed: '間に合わなかった予約',
  unreachable: '到着が間に合わない可能性',
  travel_unknown: '移動時間が不明で判断できない',
  time_unknown: '時刻が不明で判断できない',
};

export const CONSENT_TEXT =
  '「現在地を使って再計画」を押すと、ブラウザが位置情報の許可を求めます。許可した場合のみ、現在地から次の予定までの経路検索に一度だけ使います。' +
  '座標は保存せず、画面にも表示しません。拒否・取得失敗の場合は現在地なしで再計画します。';

export interface TravelViewProps {
  trip: Trip;
  route: TripScreenRoute;
  dayIndex: number;
  onDay: (i: number) => void;
  completed: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  missed: ReadonlySet<string>;
  onToggle: (kind: 'completed' | 'pinned' | 'missed', id: string) => void;
  onReplan: (withLocation: boolean) => void;
  replan: { state: 'idle' } | { state: 'loading' } | { state: 'ok'; result: ReplanResult };
  onApply: (c: ReplanCandidate) => void;
  saved: TripPatchResult | null;
  error: ApiError | null;
  onReload: () => void;
  onDismissError: () => void;
  busy: boolean;
}

function ReplanCandidateCard({ c, base, onApply, busy }: { c: ReplanCandidate; base: Trip; onApply: (c: ReplanCandidate) => void; busy: boolean }) {
  const titleOf = useMemo(() => {
    const own = titleLookup(c.trip);
    const old = titleLookup(base);
    return (id: string) => (own(id) !== id ? own(id) : old(id));
  }, [c.trip, base]);
  const whyId = `ed-why-${c.candidateId}`;
  return (
    <li className="ed-cand">
      <p className="ed-title"><span className="ed-flag">{c.kind === 'keep_order' ? '順番そのまま' : '順番を入れ替え'}</span>{c.summary}</p>
      <DiffView diff={c.diff} titleOf={titleOf} />
      <p className="ed-meta">動かさない予定: 完了 {c.kept.completed.length}件 / 固定 {c.kept.fixed.length}件 / 時刻を組み直す予定 {c.retimed.length}件</p>
      {c.reservationConflicts.length > 0 && (
        <ul aria-label="予約への影響" className="ed-note">
          {c.reservationConflicts.map(r => (
            <li key={`${r.activityId}-${r.reason}`} className="u1-unknown">{titleOf(r.activityId)}: {CONFLICT_LABEL[r.reason]}</li>
          ))}
        </ul>
      )}
      {c.untimed.length > 0 && (
        <ul aria-label="時刻を決められなかった予定" className="ed-note">
          {c.untimed.map(u => <li key={u.activityId}>{titleOf(u.activityId)}: 時刻未定のまま（{u.reason}）</li>)}
        </ul>
      )}
      {c.unknown.length > 0 && <p className="ed-note u1-unknown">不明: {c.unknown.join('、')}</p>}
      {c.warnings.map(w => <p key={w} className="ed-note">注意: {w}</p>)}
      <button type="button" className="btn u1-primary" disabled={busy || c.operations === null} aria-describedby={c.operations === null ? whyId : undefined} onClick={() => onApply(c)}>
        この再計画を保存する
      </button>
      {c.operations === null && <p id={whyId} className="ed-note">{NO_OPERATIONS_REASON}</p>}
    </li>
  );
}

/** Presentational travel screen (R12), rendered directly in tests. */
export function TravelView(p: TravelViewProps) {
  const idx = Math.min(Math.max(p.dayIndex, 0), Math.max(p.trip.days.length - 1, 0));
  const day = p.trip.days[idx];
  const titleOf = useMemo(() => titleLookup(p.trip), [p.trip]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleRow = (key: string) => setExpanded(x => { const n = new Set(x); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const rows = useMemo(() => (day ? tableRows(day, p.trip.places) : []), [day, p.trip.places]);
  const result = p.replan.state === 'ok' ? p.replan.result : null;
  return (
    <>
      <ScreenHeader title={`${p.trip.title}（旅行中）`} />
      <p className="it-meta">版 {p.trip.revision}</p>
      <nav className="ed-links" aria-label="関連画面">
        <a href={tripScreenHash(p.route, 'map')}>地図と旅程</a>
        <a href={tripScreenHash(p.route, 'edit')}>旅程を編集</a>
      </nav>
      {p.error && <EditError error={p.error} onReload={p.onReload} onDismiss={p.onDismissError} />}
      {p.saved && (
        <section role="status" className="ed-cand" aria-label="保存結果">
          <strong>再計画を保存しました（版 {p.saved.revision}）</strong>
          <DiffView diff={p.saved.diff} titleOf={titleOf} heading="保存した変更の差分" />
        </section>
      )}
      <div className="it-days" role="tablist" aria-label="日付">
        {p.trip.days.map((d, i) => (
          <button key={d.date} type="button" role="tab" aria-selected={i === idx} className={`it-day${i === idx ? ' it-on' : ''}`} onClick={() => p.onDay(i)}>
            {i + 1}日目 {formatDay(d.date)}
          </button>
        ))}
      </div>
      {day && (
        <ItineraryTable key={idx} rows={rows} dayDate={day.date} expanded={expanded} onToggleRow={toggleRow}
          stayBadge={r => (p.completed.has(r.key) ? <span className="ed-flag">完了</span> : null)}
          stayExtra={r => (
            <div className="ed-actions">
              <button type="button" className="btn" aria-pressed={p.completed.has(r.key)} onClick={() => p.onToggle('completed', r.key)}>完了にする</button>
              <button type="button" className="btn" aria-pressed={p.pinned.has(r.key)} onClick={() => p.onToggle('pinned', r.key)}>今回は動かさない</button>
              {r.item.fixed && <button type="button" className="btn" aria-pressed={p.missed.has(r.key)} onClick={() => p.onToggle('missed', r.key)}>間に合わなかった</button>}
            </div>
          )} />
      )}
      <p className="ed-note">完了・固定・間に合わなかったの印は、この再計画の計算にだけ使います（旅程には保存しません）。</p>

      <section aria-label="再計画">
        <h2 className="u1-sub">残りの予定を再計画</h2>
        <p className="ed-consent">{CONSENT_TEXT}</p>
        <div className="ed-bar">
          <button type="button" className="btn u1-primary" disabled={p.busy} onClick={() => p.onReplan(true)}>現在地を使って再計画（位置情報を許可）</button>
          <button type="button" className="btn" disabled={p.busy} onClick={() => p.onReplan(false)}>現在地を使わずに再計画</button>
        </div>
        <div aria-live="polite">
          {p.replan.state === 'loading' && <p className="u1-loading" role="status">再計画を計算中…（何も保存されません）</p>}
          {result && (
            <>
              <p className="ed-meta">基準の版 {result.baseRevision} / 対象: {result.dayIndex + 1}日目 / 出発地点の扱い: {startLabel(result.start.kind)}</p>
              {result.startLeg && (
                <p className="ed-meta">現在地から次の予定まで（表示のみ）: {LEG_MODE_LABEL[result.startLeg.mode]} {durationText(result.startLeg.durationSeconds)} / 運賃 {fareText(result.startLeg.fare)}</p>
              )}
              {!result.startLeg && <p className="ed-meta">現在地から次の予定までの移動: {VALUE_UNKNOWN}</p>}
              {result.candidates.length === 0 && <p className="u1-empty">再計画の候補がありませんでした。</p>}
              <ul className="ed-list">
                {result.candidates.map(c => <ReplanCandidateCard key={c.candidateId} c={c} base={p.trip} onApply={p.onApply} busy={p.busy} />)}
              </ul>
            </>
          )}
        </div>
      </section>
    </>
  );
}

function startLabel(k: ReplanResult['start']['kind']): string {
  return { coords: '現在地', place: '指定の地点', last_completed: '最後に完了した予定', ongoing: '進行中の予定', none: '指定なし' }[k];
}

export function TravelScreen({ route, api: apiProp, geo, onBack }: { route: TripScreenRoute; api?: TripEditApi; geo?: GeoLike | null; onBack?: () => void }) {
  const api = useMemo(() => apiProp ?? (route.mode === 'mock' ? createMockTripEditApi() : createLiveTripEditApi()), [apiProp, route.mode]);
  const [load, setLoad] = useState<{ state: 'loading' } | { state: 'ok'; trip: Trip } | { state: 'error'; error: ApiError }>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [dayIndex, setDayIndex] = useState(0);
  const [sets, setSets] = useState({ completed: new Set<string>(), pinned: new Set<string>(), missed: new Set<string>() });
  const [replan, setReplan] = useState<TravelViewProps['replan']>({ state: 'idle' });
  const [saved, setSaved] = useState<TripPatchResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    void api.getTrip(route.tripId).then(r => { if (live) setLoad(r.ok ? { state: 'ok', trip: r.data } : { state: 'error', error: r.error }); });
    return () => { live = false; };
  }, [api, route.tripId, attempt]);

  const toggle = useCallback((kind: 'completed' | 'pinned' | 'missed', id: string) => {
    setSets(s => { const n = new Set(s[kind]); if (n.has(id)) n.delete(id); else n.add(id); return { ...s, [kind]: n }; });
    setReplan({ state: 'idle' });
  }, []);
  const reload = useCallback(() => { setError(null); setSaved(null); setReplan({ state: 'idle' }); setAttempt(a => a + 1); }, []);

  if (load.state !== 'ok') {
    return (
      <Shell route={route}>
        <ScreenHeader title="旅行中" {...(onBack ? { onBack } : {})} />
        {load.state === 'error'
          ? <ErrorBox title="旅程を読み込めませんでした" error={load.error} onRetry={() => setAttempt(a => a + 1)} />
          : <p className="u1-loading" role="status">サーバーから旅程を読み込み中…</p>}
      </Shell>
    );
  }
  const trip = load.trip;

  const run = async (withLocation: boolean) => {
    setBusy(true); setError(null); setSaved(null); setReplan({ state: 'loading' });
    // Coordinates exist only inside this call: they are not kept in state or storage.
    const location = withLocation ? await requestLocation(geo === undefined ? (typeof navigator !== 'undefined' ? navigator.geolocation : null) : geo) : SKIPPED;
    const r = await api.replan(route.tripId, buildReplanRequest({ expectedRevision: trip.revision, location, ...sets }));
    setBusy(false);
    if (r.ok) setReplan({ state: 'ok', result: r.data });
    else { setReplan({ state: 'idle' }); setError(r.error); }
  };
  const apply = async (c: ReplanCandidate) => {
    if (c.operations === null || replan.state !== 'ok') return;
    setBusy(true); setError(null);
    const r = await api.patch(route.tripId, { expectedRevision: replan.result.baseRevision, operations: c.operations });
    setBusy(false);
    if (r.ok) { setLoad({ state: 'ok', trip: r.data.trip }); setReplan({ state: 'idle' }); setSaved(r.data); } else setError(r.error);
  };

  return (
    <Shell route={route}>
      <TravelView trip={trip} route={route} dayIndex={dayIndex} onDay={setDayIndex} {...sets} onToggle={toggle}
        onReplan={w => void run(w)} replan={replan} onApply={c => void apply(c)} saved={saved} error={error}
        onReload={reload} onDismissError={() => setError(null)} busy={busy} />
    </Shell>
  );
}

function Shell({ route, children }: { route: TripScreenRoute; children: React.ReactNode }) {
  return (
    <div className="u1-root">
      {route.mode === 'mock' && <MockBanner />}
      <main className="u1-main" aria-label="旅行中の画面">{children}</main>
    </div>
  );
}
