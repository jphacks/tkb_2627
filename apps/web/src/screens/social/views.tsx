/**
 * U08 presentational views (no I/O). Everything shown comes from an API result; nothing is invented.
 * Unknown values are shown as 未取得 (never 0).
 */
import type { ApiError, CopyResult, ErrorCode, Group, Post, PostPreview, PostSnapshot, PostSummary, Trip, Visibility } from '@tkb/contracts';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { TRANSPORT_LABEL, VALIDATION_LABEL, VISIBILITY_LABEL } from '../../components/labels.ts';
import { formatDay } from '../../lib/format.ts';
import type { DataSource, FeedScope } from './api.ts';
import { PostItinerary } from './PostItinerary.tsx';
import { NOT_VISIBLE, ROLE_LABEL, errorText, redactedLabel } from './messages.ts';

export const SCOPE_LABEL: Record<FeedScope, string> = {
  public: '公開',
  mine: '自分の投稿',
  groups: 'グループ',
  following: 'フォロー中',
};

const EMPTY_FEED: Record<FeedScope, string> = {
  following: 'フォローしている人の投稿はまだありません。',
  public: '公開された投稿はまだありません。',
  mine: 'まだ投稿していません。「投稿する」から旅程を公開できます。',
  groups: '所属グループの投稿はまだありません。',
};

/** API error with a Japanese message. 404 always reads 見つからないか閲覧権限がありません. */
export function ResultError({ error, title, onRetry, overrides }: {
  error: ApiError;
  title: string;
  onRetry?: () => void;
  overrides?: Partial<Record<ErrorCode, string>>;
}) {
  const t = error.code === 'NOT_FOUND' ? NOT_VISIBLE : title;
  return (
    <ErrorBox
      title={t}
      error={{ message: errorText(error, overrides), code: error.code, retryable: error.retryable, requestId: error.requestId }}
      {...(onRetry && error.code !== 'NOT_FOUND' ? { onRetry } : {})}
    />
  );
}

export function SourceLine({ source, status }: { source: DataSource; status: number }) {
  return (
    <p className="u1-srcline">
      <span className="u1-source" title="この画面のデータの出どころ">
        出典: {source === 'mock' ? 'モック' : '共有サーバー'}（HTTP {status}）
      </span>
    </p>
  );
}

export function VisibilityChip({ visibility }: { visibility: Visibility }) {
  return <span className={`s8-vis s8-vis-${visibility}`}>{VISIBILITY_LABEL[visibility]}</span>;
}

export function PostCardBody({ post }: { post: PostSummary }) {
  return (
    <>
      <span className="u1-cand-title">{post.title}</span>
      <span className="meta">
        {post.authorDisplayName} / {post.area} / {formatDay(post.startDate)}〜 / <VisibilityChip visibility={post.visibility} />
      </span>
      {post.story !== '' && <span className="s8-story">{post.story}</span>}
    </>
  );
}

export interface FeedViewProps {
  scope: FeedScope;
  status: 'loading' | 'ready' | 'error';
  items: PostSummary[];
  nextCursor: string | null;
  error: ApiError | null;
  loadingMore: boolean;
  moreError: ApiError | null;
  source: DataSource;
  httpStatus: number;
  onOpen: (postId: string) => void;
  onMore: () => void;
  onRetry: () => void;
}

/** K14 feed: loading / error / empty / list, with cursor paging by button only (no automatic loop). */
export function FeedView(p: FeedViewProps) {
  if (p.status === 'loading') return <p role="status" className="u1-loading">フィードを読み込み中…</p>;
  if (p.status === 'error' && p.error) return <ResultError title="フィードを読み込めませんでした" error={p.error} onRetry={p.onRetry} />;
  return (
    <>
      {p.items.length === 0 ? (
        <div className="u1-empty"><p><strong>{EMPTY_FEED[p.scope]}</strong></p></div>
      ) : (
        <ul className="u1-cards" aria-label={`${SCOPE_LABEL[p.scope]}の投稿`}>
          {p.items.map(post => (
            <li key={post.postId}>
              <button type="button" className="u1-card u1-cardbtn" onClick={() => p.onOpen(post.postId)}>
                <PostCardBody post={post} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {p.moreError && <ResultError title="続きを読み込めませんでした" error={p.moreError} />}
      {p.nextCursor !== null && (
        <div className="u1-actions">
          <button type="button" className="btn" onClick={p.onMore} disabled={p.loadingMore}>
            {p.loadingMore ? '読み込み中…' : 'さらに読み込む'}
          </button>
        </div>
      )}
      <SourceLine source={p.source} status={p.httpStatus} />
    </>
  );
}

/** The public snapshot exactly as the API returned it (K12/K14). */
export function SnapshotView({ snapshot }: { snapshot: PostSnapshot }) {
  const c = snapshot.constraints;
  return (
    <div className="s8-snapshot">
      <p className="meta">
        {c.area} / {formatDay(c.startDate)} - {formatDay(c.endDate)} / {c.timeZone} / {TRANSPORT_LABEL[c.transportMode]}
      </p>
      <PostItinerary days={snapshot.days} places={snapshot.places} />
      {snapshot.places.length > 0 && (
        <details>
          <summary>含まれる地点（{snapshot.places.length}件）</summary>
          <ul>
            {snapshot.places.map(p => (
              <li key={p.placeId}>{p.name}<span className="meta">出典: {p.provenance.attribution ?? p.provenance.source}</span></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** K12 result: what will be public, what was removed, and for whom. */
export function PreviewView({ preview, visibility, groupName, story }: {
  preview: PostPreview;
  visibility: Visibility;
  groupName: string | null;
  story: string;
}) {
  return (
    <section className="s8-preview" aria-label="公開前の確認">
      <h2 className="u1-sub">公開される内容</h2>
      <p>
        公開範囲: <VisibilityChip visibility={visibility} />
        {visibility === 'group' && <> グループ「{groupName ?? '（名前を取得できません）'}」のメンバーだけ</>}
      </p>
      <article className="u1-card">
        <h3 className="u1-cand-title">{preview.snapshot.title}</h3>
        {story !== '' && <p className="s8-story">{story}</p>}
        <SnapshotView snapshot={preview.snapshot} />
      </article>
      <h2 className="u1-sub">公開されない情報（サーバーが取り除いた項目）</h2>
      {preview.redactedFields.length === 0 ? (
        <p className="meta">取り除いた項目はありません。</p>
      ) : (
        <ul className="s8-redacted">
          {preview.redactedFields.map(f => <li key={f}>{redactedLabel(f)}</li>)}
        </ul>
      )}
      <p className="meta">この確認は {new Date(preview.expiresAt).toLocaleString('ja-JP')} まで有効です。投稿後に旅程を編集しても、投稿の内容は変わりません。</p>
    </section>
  );
}

export function PostDetailView({ post }: { post: Post }) {
  return (
    <article className="u1-card" aria-label="投稿の内容">
      <h2 className="u1-cand-title">{post.title}</h2>
      <p className="meta">
        {post.authorDisplayName} / 投稿 {new Date(post.createdAt).toLocaleString('ja-JP')} / 版 {post.postRevision} / <VisibilityChip visibility={post.visibility} />
      </p>
      {post.story !== '' && <p className="s8-story">{post.story}</p>}
      <SnapshotView snapshot={post.snapshot} />
    </article>
  );
}

/** K16 result: the copy is the viewer's own trip and must be re-validated for the new dates. */
export function CopyResultView({ result }: { result: CopyResult }) {
  return (
    <div className="u1-ok" role="status">
      <p><strong>自分の旅程としてコピーしました。</strong></p>
      <p>
        状態: <span className={`u1-state u1-state-${result.validationState}`}>{VALIDATION_LABEL[result.validationState]}</span>（版 {result.revision}）
      </p>
      <p className="meta">時刻・運賃・乗換・費用は引き継いでいません。新しい日付に合わせて旅程を再検証・再編集してください。</p>
    </div>
  );
}

/** A copied trip (K09 read): shown so the user can check what must be re-validated. */
export function CopiedTripView({ trip }: { trip: Trip }) {
  const c = trip.constraints;
  return (
    <article className="u1-card" aria-label="コピーした旅程">
      <h2 className="u1-cand-title">{trip.title}</h2>
      <p className="meta">{c.area} / {formatDay(c.startDate)} - {formatDay(c.endDate)} / {c.timeZone} / 版 {trip.revision}</p>
      <p><span className={`u1-state u1-state-${trip.validationState}`}>{VALIDATION_LABEL[trip.validationState]}</span></p>
      {trip.warnings.length > 0 && (
        <ul className="note">
          {trip.warnings.map(w => <li key={w}>{w}</li>)}
        </ul>
      )}
      <PostItinerary days={trip.days} places={trip.places} />
    </article>
  );
}

export function GroupListView({ groups, onInvite, onLeave, busy }: {
  groups: Group[];
  onInvite: (groupId: string) => void;
  onLeave: (groupId: string) => void;
  busy: boolean;
}) {
  if (groups.length === 0) {
    return <div className="u1-empty"><p><strong>所属しているグループはありません。</strong></p><p className="meta">下のフォームで作成するか、招待リンクから参加してください。</p></div>;
  }
  return (
    <ul className="u1-cards" aria-label="所属グループ">
      {groups.map(g => (
        <li key={g.groupId} className="u1-card">
          <p><strong>{g.name}</strong></p>
          <p className="meta">あなたの役割: {ROLE_LABEL[g.role]} / 作成 {new Date(g.createdAt).toLocaleDateString('ja-JP')}</p>
          <div className="u1-actions">
            {g.role !== 'member' && (
              <button type="button" className="btn" disabled={busy} onClick={() => onInvite(g.groupId)}>招待リンクを作る</button>
            )}
            {g.role !== 'owner' && (
              <button type="button" className="btn u1-danger" disabled={busy} onClick={() => onLeave(g.groupId)}>このグループから抜ける</button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
