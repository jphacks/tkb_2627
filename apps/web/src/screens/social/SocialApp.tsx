/**
 * U08 SNS and group screens (R20-R22, K11-K17). Open with `#social` (mock by default) or an invite link
 * `/invite#<token>` (shared server by default). The data source can be switched at the top; mock data is
 * always labelled. The session lives in an HttpOnly cookie (server) and the CSRF token in memory only.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import type { ApiError, CopyResult, Group, Post, PostPreview, PostSummary, TripSummary, Visibility } from '@tkb/contracts';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { VISIBILITY_LABEL } from '../../components/labels.ts';
import { MOCK_NOTICE } from '../../mocks/index.ts';
import { formatDay } from '../../lib/format.ts';
import { createHttpSocialApi, inviteTokenFrom, type DataSource, type FeedScope, type SessionUser, type SocialApi, type SocialResult } from './api.ts';
import { VISIBILITY_HELP } from './messages.ts';
import { createMockSocialApi, type MockSocialScenario } from './mockSocialApi.ts';
import { initialNav, navReducer, tabOf, type SocialNavAction, type SocialTab } from './nav.ts';
import {
  CopiedTripView,
  CopyResultView,
  FeedView,
  GroupListView,
  PostDetailView,
  PreviewView,
  ResultError,
  SCOPE_LABEL,
  SourceLine,
} from './views.tsx';
import '../../components/u01.css';
import './social.css';

type Load<T> = { status: 'loading' } | { status: 'done'; result: SocialResult<T> };

/** Runs `load` when `key` changes and on reload(). A stale response is ignored. */
function useLoad<T>(load: () => Promise<SocialResult<T>>, key: string): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void load().then(result => {
      if (live) setState({ status: 'done', result });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  return [state, useCallback(() => setNonce(n => n + 1), [])];
}

const TABS: { tab: SocialTab; label: string }[] = [
  { tab: 'feed', label: 'フィード' },
  { tab: 'compose', label: '投稿する' },
  { tab: 'groups', label: 'グループ' },
];

const SCENARIOS: { value: MockSocialScenario; label: string }[] = [
  { value: 'normal', label: '通常' },
  { value: 'empty', label: '空（投稿・旅程なし）' },
  { value: 'error', label: 'エラー' },
  { value: 'slow', label: '低速' },
];

export interface SocialAppProps {
  initialMode?: DataSource;
  /** Token from an invite link (`/invite#<token>`). */
  inviteToken?: string | null;
  /** Test hook: replaces the API for a mode. */
  makeApi?: (mode: DataSource, scenario: MockSocialScenario) => SocialApi;
}

const defaultMakeApi = (mode: DataSource, scenario: MockSocialScenario): SocialApi =>
  mode === 'mock' ? createMockSocialApi({ scenario }) : createHttpSocialApi();

export function SocialApp({ initialMode = 'mock', inviteToken = null, makeApi = defaultMakeApi }: SocialAppProps) {
  const [mode, setMode] = useState<DataSource>(initialMode);
  const [scenario, setScenario] = useState<MockSocialScenario>('normal');
  // The invite token is kept in memory and removed from the address bar, so it is not left in history.
  const [token] = useState(inviteToken);
  // One API object per data source (and mock scenario); a new one resets the session and every screen.
  const api = useMemo(() => makeApi(mode, scenario), [makeApi, mode, scenario]);
  useEffect(() => {
    if (token && typeof history !== 'undefined' && typeof location !== 'undefined' && location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [token]);
  return (
    <div className="u1-root">
      {mode === 'mock' ? (
        <div role="status" className="u1-banner">
          <span className="u1-banner-tag">MOCK</span>
          <span>{MOCK_NOTICE}（SNS・グループの画面）</span>
        </div>
      ) : (
        <div role="status" className="s8-server-banner">
          <span className="s8-server-tag">SERVER</span>
          <span>共有サーバー（/api）のデータです。投稿・グループの変更は実際に保存されます。</span>
        </div>
      )}
      <div className="u1-scenario">
        <label htmlFor="s8-mode">データの接続先</label>
        <select id="s8-mode" value={mode} onChange={e => setMode(e.target.value as DataSource)}>
          <option value="mock">モック（画面確認用）</option>
          <option value="server">共有サーバー（/api）</option>
        </select>
        {mode === 'mock' && (
          <>
            <label htmlFor="s8-scenario">シナリオ</label>
            <select id="s8-scenario" value={scenario} onChange={e => setScenario(e.target.value as MockSocialScenario)}>
              {SCENARIOS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </>
        )}
      </div>
      <SocialShell key={`${mode}:${scenario}`} api={api} inviteToken={token} />
    </div>
  );
}

function SocialShell({ api, inviteToken }: { api: SocialApi; inviteToken: string | null }) {
  const [nav, dispatch] = useReducer(navReducer, inviteToken, initialNav);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  useEffect(() => {
    let live = true;
    void api.me().then(r => {
      if (!live) return;
      setUser(r.ok ? r.data : null);
      setChecking(false);
    });
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [nav.screen]);

  const tab = tabOf(nav.screen);
  return (
    <>
      <SessionBar api={api} user={user} checking={checking} onChange={setUser} />
      <nav className="s8-subnav" aria-label="SNSメニュー">
        {TABS.map(t => (
          <button key={t.tab} type="button" className="tab" aria-pressed={t.tab === tab} aria-current={t.tab === tab ? 'page' : undefined}
            onClick={() => dispatch({ type: 'tab', tab: t.tab })}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="u1-main" ref={main} tabIndex={-1} aria-label="SNSの画面">
        <SocialScreenView api={api} nav={nav} dispatch={dispatch} user={user} />
      </main>
    </>
  );
}

function SocialScreenView({ api, nav, dispatch, user }: {
  api: SocialApi;
  nav: ReturnType<typeof initialNav>;
  dispatch: (a: SocialNavAction) => void;
  user: SessionUser | null;
}) {
  const s = nav.screen;
  const back = nav.history.length > 0 ? () => dispatch({ type: 'back' }) : undefined;
  // A new user (login / logout / switch) re-runs every load, so nothing of the previous account stays on screen.
  const k = user?.userId ?? 'anon';
  switch (s.name) {
    case 'feed':
      return <FeedScreen key={k} api={api} loggedIn={user !== null} onOpen={(postId, mine) => dispatch({ type: 'openPost', postId, mine })} />;
    case 'post':
      return <PostScreen key={`${k}:${s.postId}`} api={api} postId={s.postId} mine={s.mine} user={user} onBack={back}
        onCopied={result => dispatch({ type: 'copied', result })} onDeleted={() => dispatch({ type: 'tab', tab: 'feed' })} />;
    case 'compose':
      return <ComposeScreen key={k} api={api} user={user} onPosted={postId => dispatch({ type: 'posted', postId })} />;
    case 'groups':
      return <GroupsScreen key={k} api={api} user={user} />;
    case 'invite':
      return <InviteScreen key={k} api={api} user={user} token={s.token} onJoined={() => dispatch({ type: 'joined' })} />;
    case 'copied':
      return <CopiedScreen key={`${k}:${s.result.tripId}`} api={api} result={s.result} onBack={back} />;
  }
}

// ---------- session ----------

export function SessionBar({ api, user, checking, onChange }: {
  api: SocialApi;
  user: SessionUser | null;
  checking: boolean;
  onChange: (u: SessionUser | null) => void;
}) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api.login(loginId, password);
    setBusy(false);
    setPassword('');
    if (r.ok) onChange(r.data);
    else setError(r.error);
  }
  async function logout() {
    setBusy(true);
    await api.logout();
    setBusy(false);
    onChange(null);
  }

  if (checking) return <p role="status" className="s8-session u1-loading">ログイン状態を確認中…</p>;
  if (user) {
    return (
      <div className="s8-session">
        <span>ログイン中: <strong>{user.displayName}</strong></span>
        <button type="button" className="btn" onClick={() => void logout()} disabled={busy}>ログアウト</button>
      </div>
    );
  }
  return (
    <form className="s8-session s8-login" onSubmit={e => void submit(e)} aria-label="ログイン">
      <div className="u1-field">
        <label htmlFor="s8-login-id">ログインID</label>
        <input id="s8-login-id" type="text" autoComplete="username" value={loginId} onChange={e => setLoginId(e.target.value)} required maxLength={64} />
      </div>
      <div className="u1-field">
        <label htmlFor="s8-login-pw">パスワード</label>
        <input id="s8-login-pw" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={256} />
      </div>
      <button type="submit" className="btn u1-primary" disabled={busy || loginId === '' || password === ''}>ログイン</button>
      {api.source === 'mock' && <p className="meta">モック: ログインIDは demo-a または demo-b（パスワードは何でも可）。</p>}
      {error && (
        <ResultError title="ログインできませんでした" error={error}
          overrides={{ UNAUTHENTICATED: 'ログインIDまたはパスワードが違います。', VALIDATION_FAILED: 'ログインIDとパスワードを入力してください。' }} />
      )}
    </form>
  );
}

function LoginRequired({ what }: { what: string }) {
  return <div className="u1-empty"><p><strong>{what}にはログインが必要です。</strong></p><p className="meta">画面上部のフォームからログインしてください。</p></div>;
}

// ---------- feed (K14) ----------

interface FeedState {
  status: 'loading' | 'ready' | 'error';
  items: PostSummary[];
  nextCursor: string | null;
  error: ApiError | null;
  httpStatus: number;
}

function FeedScreen({ api, loggedIn, onOpen }: { api: SocialApi; loggedIn: boolean; onOpen: (postId: string, mine: boolean) => void }) {
  const [scope, setScope] = useState<FeedScope>('public');
  const [nonce, setNonce] = useState(0);
  const [feed, setFeed] = useState<FeedState>({ status: 'loading', items: [], nextCursor: null, error: null, httpStatus: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  const needsLogin = scope !== 'public' && !loggedIn;

  useEffect(() => {
    if (needsLogin) return;
    let live = true;
    setFeed({ status: 'loading', items: [], nextCursor: null, error: null, httpStatus: 0 });
    setMoreError(null);
    void api.getFeed(scope).then(r => {
      if (!live) return;
      setFeed(r.ok
        ? { status: 'ready', items: r.data.items, nextCursor: r.data.nextCursor, error: null, httpStatus: r.status }
        : { status: 'error', items: [], nextCursor: null, error: r.error, httpStatus: r.status });
    });
    return () => {
      live = false;
    };
  }, [api, scope, nonce, needsLogin]);

  async function more() {
    if (feed.nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const r = await api.getFeed(scope, feed.nextCursor);
    setLoadingMore(false);
    if (!r.ok) {
      setMoreError(r.error);
      return;
    }
    setFeed(f => {
      const seen = new Set(f.items.map(i => i.postId));
      return { ...f, items: [...f.items, ...r.data.items.filter(i => !seen.has(i.postId))], nextCursor: r.data.nextCursor, httpStatus: r.status };
    });
  }

  return (
    <section aria-label="フィード">
      <ScreenHeader title="フィード" />
      <div className="tabs" role="group" aria-label="表示する投稿">
        {(Object.keys(SCOPE_LABEL) as FeedScope[]).map(s => (
          <button key={s} type="button" className="tab" aria-pressed={s === scope} onClick={() => setScope(s)}>{SCOPE_LABEL[s]}</button>
        ))}
      </div>
      {needsLogin ? (
        <LoginRequired what={`「${SCOPE_LABEL[scope]}」の表示`} />
      ) : (
        <FeedView scope={scope} status={feed.status} items={feed.items} nextCursor={feed.nextCursor} error={feed.error}
          loadingMore={loadingMore} moreError={moreError} source={api.source} httpStatus={feed.httpStatus}
          onOpen={postId => onOpen(postId, scope === 'mine')} onMore={() => void more()} onRetry={() => setNonce(n => n + 1)} />
      )}
    </section>
  );
}

// ---------- post detail, owner actions (K15), copy (K16) ----------

function PostScreen({ api, postId, mine, user, onBack, onCopied, onDeleted }: {
  api: SocialApi;
  postId: string;
  mine: boolean;
  user: SessionUser | null;
  onBack: (() => void) | undefined;
  onCopied: (r: CopyResult) => void;
  onDeleted: () => void;
}) {
  const [state, reload] = useLoad(() => api.getPost(postId), postId);
  const [post, setPost] = useState<Post | null>(null);
  useEffect(() => {
    setPost(state.status === 'done' && state.result.ok ? state.result.data : null);
  }, [state]);
  return (
    <section aria-label="投稿の詳細">
      <ScreenHeader title="投稿の詳細" {...(onBack ? { onBack } : {})} />
      {state.status === 'loading' ? (
        <p role="status" className="u1-loading">投稿を読み込み中…</p>
      ) : !state.result.ok ? (
        <ResultError title="投稿を読み込めませんでした" error={state.result.error} onRetry={reload} />
      ) : post ? (
        <>
          <PostDetailView post={post} />
          <SourceLine source={api.source} status={state.result.status} />
          {mine && user && <OwnerPanel api={api} post={post} onChanged={setPost} onDeleted={onDeleted} />}
          {user ? <CopyForm api={api} post={post} onCopied={onCopied} /> : <LoginRequired what="自分の旅程としてコピーする" />}
        </>
      ) : null}
    </section>
  );
}

function VisibilityFields({ name, value, onChange, groups, groupId, onGroup }: {
  name: string;
  value: Visibility;
  onChange: (v: Visibility) => void;
  groups: Load<Group[]>;
  groupId: string;
  onGroup: (id: string) => void;
}) {
  return (
    <>
      <fieldset className="u1-field u1-fieldset">
        <legend>公開範囲</legend>
        {(['private', 'group', 'public'] as const).map(v => (
          <label key={v} className="u1-choice">
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
            <span><strong>{VISIBILITY_LABEL[v]}</strong><span className="meta">{VISIBILITY_HELP[v]}</span></span>
          </label>
        ))}
      </fieldset>
      {value === 'group' && (
        groups.status === 'loading' ? (
          <p role="status" className="u1-loading">グループを読み込み中…</p>
        ) : !groups.result.ok ? (
          <ResultError title="グループを読み込めませんでした" error={groups.result.error} />
        ) : groups.result.data.length === 0 ? (
          <p className="note">所属しているグループがありません。「グループ」から作成するか、招待を受けてください。</p>
        ) : (
          <div className="u1-field">
            <label htmlFor={`${name}-group`}>公開するグループ</label>
            <select id={`${name}-group`} value={groupId} onChange={e => onGroup(e.target.value)} required>
              <option value="">選んでください</option>
              {groups.result.data.map(g => <option key={g.groupId} value={g.groupId}>{g.name}</option>)}
            </select>
          </div>
        )
      )}
    </>
  );
}

function OwnerPanel({ api, post, onChanged, onDeleted }: { api: SocialApi; post: Post; onChanged: (p: Post) => void; onDeleted: () => void }) {
  const [visibility, setVisibility] = useState<Visibility>(post.visibility);
  const [groupId, setGroupId] = useState(post.groupId ?? '');
  const [groups] = useLoad(() => api.listGroups(), 'groups');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function change(v: Visibility, g: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await api.changeVisibility(post.postId, post.postRevision, v, v === 'group' ? g : null);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onChanged(r.data);
    setVisibility(r.data.visibility);
    setDone(`公開範囲を「${VISIBILITY_LABEL[r.data.visibility]}」に変更しました（版 ${r.data.postRevision}）。`);
  }
  async function remove() {
    setBusy(true);
    setError(null);
    const r = await api.deletePost(post.postId);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDeleted();
  }

  const unchanged = visibility === post.visibility && (visibility !== 'group' || groupId === (post.groupId ?? ''));
  return (
    <section className="u1-edit" aria-label="自分の投稿の管理">
      <h2 className="u1-sub">自分の投稿の管理</h2>
      <form className="u1-form" onSubmit={e => { e.preventDefault(); void change(visibility, groupId); }}>
        <VisibilityFields name="s8-owner-vis" value={visibility} onChange={setVisibility} groups={groups} groupId={groupId} onGroup={setGroupId} />
        <div className="u1-actions">
          <button type="submit" className="btn u1-primary" disabled={busy || unchanged || (visibility === 'group' && groupId === '')}>公開範囲を変更</button>
          {post.visibility !== 'private' && (
            <button type="button" className="btn" disabled={busy} onClick={() => void change('private', '')}>公開をやめる（非公開にする）</button>
          )}
        </div>
      </form>
      <p className="meta">変更は次の読み込みから反映されます。すでに閲覧者が保存した内容は回収できません。</p>
      {!confirmDelete ? (
        <button type="button" className="btn u1-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>投稿を取り下げる（削除）</button>
      ) : (
        <div className="u1-error" role="alert">
          <strong>この投稿を削除します。元に戻せません。</strong>
          <div className="u1-actions">
            <button type="button" className="btn u1-danger" disabled={busy} onClick={() => void remove()}>削除する</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>やめる</button>
          </div>
        </div>
      )}
      {done && <p className="u1-ok" role="status">{done}</p>}
      {error && (
        <ResultError title="変更できませんでした" error={error}
          overrides={{ REVISION_CONFLICT: 'ほかの操作で投稿が更新されました。投稿を開き直してからやり直してください。', VALIDATION_FAILED: '公開範囲かグループを確認してください（所属していないグループは選べません）。' }} />
      )}
    </section>
  );
}

const IANA_HINT = 'Asia/Tokyo';

function CopyForm({ api, post, onCopied }: { api: SocialApi; post: Post; onCopied: (r: CopyResult) => void }) {
  const [startDate, setStartDate] = useState('');
  const [timeZone, setTimeZone] = useState(post.snapshot.constraints.timeZone || IANA_HINT);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const t = title.trim();
    const r = await api.copyPost(post.postId, { newStartDate: startDate, timeZone: timeZone.trim(), ...(t ? { title: t } : {}) });
    setBusy(false);
    if (r.ok) onCopied(r.data);
    else setError(r.error);
  }

  return (
    <section className="u1-edit" aria-label="自分の旅程としてコピー">
      <h2 className="u1-sub">自分の旅程としてコピー</h2>
      <p className="meta">公開された内容だけをコピーします。時刻・運賃・乗換は引き継がず、新しい日付で再検証が必要になります。</p>
      <form className="u1-form" onSubmit={e => void submit(e)}>
        <div className="u1-row2">
          <div className="u1-field">
            <label htmlFor="s8-copy-date">旅行の開始日</label>
            <input id="s8-copy-date" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required />
          </div>
          <div className="u1-field">
            <label htmlFor="s8-copy-tz">タイムゾーン</label>
            <input id="s8-copy-tz" type="text" value={timeZone} onChange={e => setTimeZone(e.target.value)} required placeholder={IANA_HINT} />
          </div>
        </div>
        <div className="u1-field">
          <label htmlFor="s8-copy-title">タイトル（空欄なら「元のタイトル（コピー）」）</label>
          <input id="s8-copy-title" type="text" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} />
        </div>
        <div className="u1-actions">
          <button type="submit" className="btn u1-primary" disabled={busy || startDate === '' || timeZone.trim() === ''}>コピーする</button>
        </div>
      </form>
      {error && (
        <ResultError title="コピーできませんでした" error={error}
          overrides={{ VALIDATION_FAILED: '開始日とタイムゾーン（例: Asia/Tokyo）を確認してください。' }} />
      )}
    </section>
  );
}

function CopiedScreen({ api, result, onBack }: { api: SocialApi; result: CopyResult; onBack: (() => void) | undefined }) {
  const [trip, reload] = useLoad(() => api.getTrip(result.tripId), result.tripId);
  return (
    <section aria-label="コピーした旅程">
      <ScreenHeader title="コピーした旅程" {...(onBack ? { onBack } : {})} />
      <CopyResultView result={result} />
      {trip.status === 'loading' ? (
        <p role="status" className="u1-loading">コピーした旅程を読み込み中…</p>
      ) : !trip.result.ok ? (
        <ResultError title="コピーした旅程を読み込めませんでした" error={trip.result.error} onRetry={reload} />
      ) : (
        <>
          <CopiedTripView trip={trip.result.data} />
          <SourceLine source={api.source} status={trip.result.status} />
        </>
      )}
      <p className="note" role="note">
        再編集は旅程の編集画面で行います（旅程ID: {result.tripId}）。旅程タブの画面は現在モックのデータだけを表示するため、共有サーバーのこの旅程はまだそこから開けません。
      </p>
    </section>
  );
}

// ---------- compose: preview (K12) -> confirm (K13) ----------

function ComposeScreen({ api, user, onPosted }: { api: SocialApi; user: SessionUser | null; onPosted: (postId: string) => void }) {
  if (!user) {
    return (
      <section aria-label="投稿する">
        <ScreenHeader title="旅程を投稿する" />
        <LoginRequired what="投稿" />
      </section>
    );
  }
  return <ComposeForm api={api} onPosted={onPosted} />;
}

function ComposeForm({ api, onPosted }: { api: SocialApi; onPosted: (postId: string) => void }) {
  const [trips, reloadTrips] = useLoad(() => api.listMyTrips(), 'trips');
  const [groups] = useLoad(() => api.listGroups(), 'groups');
  const [tripId, setTripId] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [groupId, setGroupId] = useState('');
  const [story, setStory] = useState('');
  const [preview, setPreview] = useState<PostPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ step: 'preview' | 'post'; error: ApiError } | null>(null);

  const tripList: TripSummary[] = trips.status === 'done' && trips.result.ok ? trips.result.data.items : [];
  const selected = tripList.find(t => t.tripId === tripId) ?? null;
  const groupName = groups.status === 'done' && groups.result.ok ? groups.result.data.find(g => g.groupId === groupId)?.name ?? null : null;

  async function makePreview(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    const r = await api.previewPost({
      tripId: selected.tripId,
      sourceRevision: selected.revision,
      visibility,
      ...(visibility === 'group' ? { groupId } : {}),
      story,
    });
    setBusy(false);
    setConfirmed(false);
    if (r.ok) setPreview(r.data);
    else setError({ step: 'preview', error: r.error });
  }
  async function post() {
    if (!preview || !confirmed) return;
    setBusy(true);
    setError(null);
    const r = await api.createPost(preview.previewToken);
    setBusy(false);
    if (r.ok) onPosted(r.data.postId);
    else setError({ step: 'post', error: r.error });
  }
  const restart = () => {
    setPreview(null);
    setConfirmed(false);
    setError(null);
  };

  return (
    <section aria-label="投稿する">
      <ScreenHeader title="旅程を投稿する" />
      {preview === null ? (
        <form className="u1-form" onSubmit={e => void makePreview(e)}>
          {trips.status === 'loading' ? (
            <p role="status" className="u1-loading">自分の旅程を読み込み中…</p>
          ) : !trips.result.ok ? (
            <ResultError title="旅程を読み込めませんでした" error={trips.result.error} onRetry={reloadTrips} />
          ) : tripList.length === 0 ? (
            <div className="u1-empty"><p><strong>投稿できる旅程がありません。</strong></p><p className="meta">先に旅程を作成・保存してください。</p></div>
          ) : (
            <fieldset className="u1-field u1-fieldset">
              <legend>投稿する旅程</legend>
              {tripList.map(t => (
                <label key={t.tripId} className="u1-choice">
                  <input type="radio" name="s8-trip" value={t.tripId} checked={tripId === t.tripId} onChange={() => setTripId(t.tripId)} />
                  <span><strong>{t.title}</strong><span className="meta">{t.area} / {formatDay(t.startDate)} - {formatDay(t.endDate)} / 版 {t.revision}</span></span>
                </label>
              ))}
            </fieldset>
          )}
          <VisibilityFields name="s8-compose-vis" value={visibility} onChange={setVisibility} groups={groups} groupId={groupId} onGroup={setGroupId} />
          <div className="u1-field">
            <label htmlFor="s8-story">旅行記録（任意、5000文字まで）</label>
            <textarea id="s8-story" rows={4} value={story} maxLength={5000} onChange={e => setStory(e.target.value)} aria-describedby="s8-story-count" />
            <span id="s8-story-count" className="meta">{story.length} / 5000</span>
          </div>
          <div className="u1-actions">
            <button type="submit" className="btn u1-primary" disabled={busy || !selected || (visibility === 'group' && groupId === '')}>
              {busy ? '確認を作成中…' : '公開前の確認へ'}
            </button>
          </div>
          <p className="meta">まだ投稿されません。次の画面で、公開される内容を確認してから確定します。</p>
        </form>
      ) : (
        <>
          <PreviewView preview={preview} visibility={visibility} groupName={groupName} story={story} />
          <label className="u1-choice s8-confirm">
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
            <span>上の内容が「{VISIBILITY_LABEL[visibility]}」で見られることを確認しました。</span>
          </label>
          <div className="u1-actions">
            <button type="button" className="btn u1-primary" disabled={busy || !confirmed} onClick={() => void post()}>
              {busy ? '投稿中…' : 'この内容で投稿する'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={restart}>条件を変える</button>
          </div>
        </>
      )}
      {error && (
        <ResultError title={error.step === 'preview' ? '確認を作成できませんでした' : '投稿できませんでした'} error={error.error}
          overrides={error.step === 'preview'
            ? { REVISION_CONFLICT: '旅程が更新されています。旅程の一覧を読み込み直してください。', VALIDATION_FAILED: '公開範囲かグループを確認してください（所属していないグループは選べません）。' }
            : { REVISION_CONFLICT: '確認の後に旅程が更新されました。「条件を変える」から確認をやり直してください。', EXPIRED: '確認の有効期限が切れました。「条件を変える」から確認をやり直してください。', ALREADY_COMMITTED: 'この確認はすでに投稿に使われました。' }} />
      )}
    </section>
  );
}

// ---------- groups (K17) ----------

function GroupsScreen({ api, user }: { api: SocialApi; user: SessionUser | null }) {
  if (!user) {
    return (
      <section aria-label="グループ">
        <ScreenHeader title="グループ" />
        <LoginRequired what="グループの表示" />
      </section>
    );
  }
  return <GroupsPanel api={api} user={user} />;
}

function GroupsPanel({ api, user }: { api: SocialApi; user: SessionUser }) {
  const [groups, reload] = useLoad(() => api.listGroups(), 'groups');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; error: ApiError } | null>(null);
  const [invite, setInvite] = useState<{ groupId: string; url: string; expiresAt: string } | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api.createGroup(name);
    setBusy(false);
    if (!r.ok) return setError({ title: 'グループを作成できませんでした', error: r.error });
    setName('');
    setNotice(`グループ「${r.data.name}」を作成しました。`);
    reload();
  }
  async function makeInvite(groupId: string) {
    setBusy(true);
    setError(null);
    setCopied(false);
    const r = await api.createInvite(groupId);
    setBusy(false);
    if (!r.ok) return setError({ title: '招待リンクを作成できませんでした', error: r.error });
    setInvite({ groupId, url: r.data.inviteUrl, expiresAt: r.data.expiresAt });
  }
  async function leave(groupId: string) {
    setBusy(true);
    setError(null);
    const r = await api.leaveGroup(groupId, user.userId);
    setBusy(false);
    setLeaving(null);
    if (!r.ok) return setError({ title: 'グループから抜けられませんでした', error: r.error });
    setNotice('グループから抜けました。');
    if (invite?.groupId === groupId) setInvite(null);
    reload();
  }
  async function copyLink() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const list = groups.status === 'done' && groups.result.ok ? groups.result.data : [];
  const leavingGroup = list.find(g => g.groupId === leaving) ?? null;
  return (
    <section aria-label="グループ">
      <ScreenHeader title="グループ" />
      {notice && <p className="u1-ok" role="status">{notice}</p>}
      {groups.status === 'loading' ? (
        <p role="status" className="u1-loading">グループを読み込み中…</p>
      ) : !groups.result.ok ? (
        <ResultError title="グループを読み込めませんでした" error={groups.result.error} onRetry={reload} />
      ) : (
        <>
          <GroupListView groups={list} busy={busy} onInvite={id => void makeInvite(id)} onLeave={id => setLeaving(id)} />
          <SourceLine source={api.source} status={groups.result.status} />
        </>
      )}
      {leavingGroup && (
        <div className="u1-error" role="alert">
          <strong>「{leavingGroup.name}」から抜けますか？</strong>
          <p>抜けると、このグループ向けの投稿は見られなくなります。</p>
          <div className="u1-actions">
            <button type="button" className="btn u1-danger" disabled={busy} onClick={() => void leave(leavingGroup.groupId)}>抜ける</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setLeaving(null)}>やめる</button>
          </div>
        </div>
      )}
      {invite && (
        <div className="u1-card s8-invite" aria-label="招待リンク">
          <div className="u1-field">
            <label htmlFor="s8-invite-url">招待リンク（{new Date(invite.expiresAt).toLocaleString('ja-JP')} まで有効）</label>
            <input id="s8-invite-url" type="text" readOnly value={invite.url} onFocus={e => e.currentTarget.select()} />
          </div>
          <div className="u1-actions">
            <button type="button" className="btn" onClick={() => void copyLink()}>リンクをコピー</button>
            {copied && <span role="status" className="meta">コピーしました。</span>}
          </div>
          <p className="meta">リンクを知っている人は、期限まで誰でも参加できます。1つのリンクで参加できるのは1人です。信頼できる相手にだけ渡してください。</p>
        </div>
      )}
      <form className="u1-form u1-edit" onSubmit={e => void create(e)}>
        <h2 className="u1-sub">グループを作る</h2>
        <div className="u1-field">
          <label htmlFor="s8-group-name">グループ名（100文字まで）</label>
          <input id="s8-group-name" type="text" value={name} onChange={e => setName(e.target.value)} maxLength={100} required />
        </div>
        <div className="u1-actions">
          <button type="submit" className="btn u1-primary" disabled={busy || name.trim() === ''}>作成する</button>
        </div>
      </form>
      <AcceptInviteForm api={api} onJoined={() => { setNotice('グループに参加しました。'); reload(); }} />
      <p className="meta s8-note">メンバーの一覧は、一覧を返すAPIがまだないため表示していません。</p>
      {error && <ResultError title={error.title} error={error.error} />}
    </section>
  );
}

const INVITE_OVERRIDES = {
  NOT_FOUND: '招待が見つからないか、あなた宛ての招待ではありません。',
  EXPIRED: '招待の有効期限が切れました。招待した人に新しいリンクを頼んでください。',
  ALREADY_COMMITTED: 'この招待はすでに使われたか、すでにグループのメンバーです。',
} as const;

function AcceptInviteForm({ api, onJoined }: { api: SocialApi; onJoined: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const token = inviteTokenFrom(text);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const r = await api.acceptInvite(token);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setText('');
    onJoined();
  }
  return (
    <form className="u1-form u1-edit" onSubmit={e => void submit(e)}>
      <h2 className="u1-sub">招待リンクで参加する</h2>
      <div className="u1-field">
        <label htmlFor="s8-invite-in">受け取った招待リンク</label>
        <input id="s8-invite-in" type="text" value={text} onChange={e => setText(e.target.value)} autoComplete="off"
          aria-invalid={text !== '' && !token} aria-describedby="s8-invite-help" />
        <span id="s8-invite-help" className={text !== '' && !token ? 'u1-fielderr' : 'meta'}>
          {text !== '' && !token ? '招待リンクの形式ではありません（…/invite#… の形です）。' : '…/invite#… の形のリンクを貼り付けます。'}
        </span>
      </div>
      <div className="u1-actions">
        <button type="submit" className="btn u1-primary" disabled={busy || !token}>参加する</button>
      </div>
      {error && <ResultError title="参加できませんでした" error={error} overrides={INVITE_OVERRIDES} />}
    </form>
  );
}

function InviteScreen({ api, user, token, onJoined }: { api: SocialApi; user: SessionUser | null; token: string; onJoined: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const valid = useMemo(() => inviteTokenFrom(token), [token]);
  async function accept() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const r = await api.acceptInvite(valid);
    setBusy(false);
    if (r.ok) onJoined();
    else setError(r.error);
  }
  return (
    <section aria-label="グループへの招待">
      <ScreenHeader title="グループへの招待" />
      {!valid ? (
        <div className="u1-error" role="alert"><strong>招待リンクの形式ではありません。</strong><p>リンクを最後まで正しくコピーしたか確認してください。</p></div>
      ) : !user ? (
        <LoginRequired what="招待の受諾" />
      ) : (
        <>
          <p>グループに招待されています。参加すると、そのグループ向けの投稿を見られるようになります。</p>
          <p className="meta">参加前にはグループ名は表示されません（招待された人以外にグループの存在を知らせないため）。</p>
          <div className="u1-actions">
            <button type="button" className="btn u1-primary" disabled={busy} onClick={() => void accept()}>{busy ? '参加中…' : '参加する'}</button>
          </div>
        </>
      )}
      {error && <ResultError title="参加できませんでした" error={error} overrides={INVITE_OVERRIDES} />}
    </section>
  );
}
