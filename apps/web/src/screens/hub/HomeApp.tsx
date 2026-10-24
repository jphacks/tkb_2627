/**
 * Navigation hub (#home): data-mode badge (K22), login state (K11), entry buttons and 自分の旅程 (K09).
 * Everything shown comes from the shared server; unknown values are never shown as 0.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Capabilities, TripSummary } from '@tkb/contracts';
import { VALIDATION_LABEL, UNKNOWN_LABEL } from '../../components/labels.ts';
import { formatDay } from '../../lib/format.ts';
import { createHubApi, type HubApi, type HubResult, type HubUser } from './api.ts';
import { tripLinks } from './route.ts';
import './hub.css';

const AI_REASON_LABEL: Record<string, string> = {
  SHARED_ENTRY_NO_PERSONAL_CLAUDE: '共有サーバーからは個人のClaudeを使えません',
  CLAUDE_EXECUTION_DISABLED: 'Claude実行が無効です',
  CLI_NOT_FOUND: 'Claude CLIが見つかりません',
  CLI_NOT_AUTHENTICATED: 'Claude CLIが未認証です',
  TERMS_NOT_CONFIRMED: '利用条件が未確認です',
};

export function dataModeLabel(mode: Capabilities['dataMode']): string {
  if (mode === 'fixture') return 'fixtureデータ';
  if (mode === 'live') return '実データ';
  return 'fixtureと実データの混在';
}

export function StatusView({ caps, capsError, user, userState }: {
  caps: Capabilities | null;
  capsError: boolean;
  user: HubUser | null;
  userState: 'loading' | 'in' | 'out' | 'error';
}) {
  return (
    <div className="hub-status" aria-label="接続状態">
      {caps ? (
        <>
          <span className={`hub-badge hub-badge-${caps.dataMode === 'live' ? 'live' : 'fixture'}`}>データ: {dataModeLabel(caps.dataMode)}</span>
          <span className="hub-badge">
            AI生成: {caps.aiGeneration.available ? `利用可（${caps.aiGeneration.runner === 'fake' ? 'テスト用runner' : caps.aiGeneration.runner}）` : `利用不可（${caps.aiGeneration.reason ? (AI_REASON_LABEL[caps.aiGeneration.reason] ?? caps.aiGeneration.reason) : UNKNOWN_LABEL}）`}
          </span>
        </>
      ) : (
        <span className="hub-badge">{capsError ? 'データ種別: 取得できません' : 'データ種別: 確認中…'}</span>
      )}
      <span className="hub-badge">
        {userState === 'in' && user ? `ログイン中: ${user.displayName}` : userState === 'out' ? '未ログイン' : userState === 'error' ? 'ログイン状態: 取得できません' : 'ログイン状態: 確認中…'}
      </span>
      {userState === 'out' && <a className="hub-login" href="#social">ログイン（SNS画面）</a>}
    </div>
  );
}

export function TripCard({ trip }: { trip: TripSummary }) {
  return (
    <li className="hub-trip">
      <h3>{trip.title}</h3>
      <p>{trip.area} ・ {formatDay(trip.startDate)}〜{formatDay(trip.endDate)}</p>
      <p>リビジョン {trip.revision} ・ 検証: {VALIDATION_LABEL[trip.validationState] ?? UNKNOWN_LABEL}</p>
      <div className="hub-links">
        {tripLinks(trip.tripId).map(l => (
          <a key={l.key} className="hub-link" href={l.href} aria-label={`${trip.title}の${l.label}`}>{l.label}</a>
        ))}
      </div>
    </li>
  );
}

export type TripsState =
  | { status: 'loading' }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: TripSummary[]; nextCursor: string | null; loadingMore: boolean; moreError: boolean };

export function TripsView({ state, onMore, onRetry }: { state: TripsState; onMore: () => void; onRetry: () => void }) {
  return (
    <section aria-labelledby="hub-trips-h">
      <h2 id="hub-trips-h" className="hub-sub">自分の旅程</h2>
      {state.status === 'loading' && <p role="status">読み込み中…</p>}
      {state.status === 'unauthorized' && (
        <div className="hub-msg" role="alert">
          <p>ログインしてください。</p>
          <a className="hub-login" href="#social">ログイン画面へ</a>
        </div>
      )}
      {state.status === 'error' && (
        <div className="hub-msg hub-msg-err" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={onRetry}>再読み込み</button>
        </div>
      )}
      {state.status === 'ready' && state.items.length === 0 && (
        <div className="hub-msg"><p>まだ旅程がありません。</p><p>「旅行を計画する」から作成できます。</p></div>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <>
          <ul className="hub-trips">{state.items.map(t => <TripCard key={t.tripId} trip={t} />)}</ul>
          {state.moreError && <p role="alert">続きを読み込めませんでした。</p>}
          {state.nextCursor && (
            <p><button type="button" className="btn" disabled={state.loadingMore} onClick={onMore}>{state.loadingMore ? '読み込み中…' : 'もっと見る'}</button></p>
          )}
        </>
      )}
    </section>
  );
}

export function HomeView(props: {
  caps: Capabilities | null; capsError: boolean; user: HubUser | null; userState: 'loading' | 'in' | 'out' | 'error';
  trips: TripsState; onMore: () => void; onRetry: () => void;
}) {
  return (
    <main className="hub-root">
      <h1 className="hub-title">旅行プラン</h1>
      <StatusView caps={props.caps} capsError={props.capsError} user={props.user} userState={props.userState} />
      <nav className="hub-big-row" aria-label="主な操作">
        <a className="hub-big" href="#generate">旅行を計画する</a>
        <a className="hub-big hub-big-alt" href="#social">SNS・グループ</a>
      </nav>
      <TripsView state={props.trips} onMore={props.onMore} onRetry={props.onRetry} />
      <p className="hub-sub" style={{ fontSize: 14 }}>
        <a href="#u01">モック試作（U01）</a> ・ <a href="#conditions">条件入力</a> ・ <a href="#dev-shell">開発用</a>
      </p>
    </main>
  );
}

const mergeTrips = (prev: TripSummary[], next: TripSummary[]) => {
  const seen = new Set(prev.map(t => t.tripId));
  return [...prev, ...next.filter(t => !seen.has(t.tripId))];
};

export function HomeApp({ api: injected }: { api?: HubApi }) {
  const api = useMemo(() => injected ?? createHubApi(), [injected]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsError, setCapsError] = useState(false);
  const [user, setUser] = useState<HubUser | null>(null);
  const [userState, setUserState] = useState<'loading' | 'in' | 'out' | 'error'>('loading');
  const [trips, setTrips] = useState<TripsState>({ status: 'loading' });

  const loadFirst = useCallback(() => {
    setTrips({ status: 'loading' });
    void api.listTrips().then((r: HubResult<{ items: TripSummary[]; nextCursor: string | null }>) => {
      if (r.ok) setTrips({ status: 'ready', items: r.data.items, nextCursor: r.data.nextCursor, loadingMore: false, moreError: false });
      else if (r.kind === 'unauthorized') setTrips({ status: 'unauthorized' });
      else setTrips({ status: 'error', message: '旅程を取得できませんでした。' });
    });
  }, [api]);

  useEffect(() => {
    let live = true;
    void api.capabilities().then(r => { if (!live) return; if (r.ok) setCaps(r.data); else setCapsError(true); });
    void api.me().then(r => {
      if (!live) return;
      if (r.ok) { setUser(r.data); setUserState('in'); } else setUserState(r.kind === 'unauthorized' ? 'out' : 'error');
    });
    loadFirst();
    return () => { live = false; };
  }, [api, loadFirst]);

  const onMore = () => {
    if (trips.status !== 'ready' || !trips.nextCursor || trips.loadingMore) return;
    const cur = trips;
    setTrips({ ...cur, loadingMore: true, moreError: false });
    void api.listTrips(cur.nextCursor).then(r => {
      if (r.ok) setTrips({ status: 'ready', items: mergeTrips(cur.items, r.data.items), nextCursor: r.data.nextCursor, loadingMore: false, moreError: false });
      else setTrips({ ...cur, loadingMore: false, moreError: true });
    });
  };

  return <HomeView caps={caps} capsError={capsError} user={user} userState={userState} trips={trips} onMore={onMore} onRetry={loadFirst} />;
}
