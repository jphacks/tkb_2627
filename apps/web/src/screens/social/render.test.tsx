import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiError, Post } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { createMockSocialApi, mockSnapshot } from './mockSocialApi.ts';
import { initialNav, navReducer } from './nav.ts';
import { SocialApp } from './SocialApp.tsx';
import {
  CopiedTripView,
  CopyResultView,
  FeedView,
  GroupListView,
  PostDetailView,
  PreviewView,
  ResultError,
  type FeedViewProps,
} from './views.tsx';

const noop = () => {};
const renderToString = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const err = (code: ApiError['code']): ApiError => ({ code, message: 'Not found.', retryable: false, requestId: 'req_x' });

const base: FeedViewProps = {
  scope: 'public', status: 'ready', items: [], nextCursor: null, error: null, loadingMore: false, moreError: null,
  source: 'server', httpStatus: 200, onOpen: noop, onMore: noop, onRetry: noop,
};

async function samplePost(): Promise<Post> {
  const r = await createMockSocialApi().getPost('fx_post_1');
  if (!r.ok) throw new Error('post');
  return r.data;
}

describe('U08 feed view (K14)', () => {
  it('loading, empty per scope, and error states', () => {
    expect(renderToString(<FeedView {...base} status="loading" />)).toContain('フィードを読み込み中');
    expect(renderToString(<FeedView {...base} />)).toContain('公開された投稿はまだありません');
    expect(renderToString(<FeedView {...base} scope="mine" />)).toContain('まだ投稿していません');
    expect(renderToString(<FeedView {...base} scope="groups" />)).toContain('所属グループの投稿はまだありません');
    const html = renderToString(<FeedView {...base} status="error" error={err('UNAVAILABLE')} />);
    expect(html).toContain('サーバーに接続できません');
    expect(html).toContain('再試行');
  });

  it('lists only the items the API returned, with さらに読み込む only when there is a cursor', async () => {
    const feed = await createMockSocialApi().getFeed('public');
    if (!feed.ok) throw new Error('feed');
    const html = renderToString(<FeedView {...base} items={feed.data.items} nextCursor="1" />);
    for (const p of feed.data.items) expect(html).toContain(p.title);
    expect(html).toContain('さらに読み込む');
    expect(html).not.toContain('Aだけが見られる');
    expect(renderToString(<FeedView {...base} items={feed.data.items} />)).not.toContain('さらに読み込む');
    expect(html).toContain('出典: 共有サーバー（HTTP 200）');
  });
});

describe('U08 errors', () => {
  it('404 always reads 見つからないか閲覧権限がありません, without a retry button', () => {
    const html = renderToString(<ResultError title="投稿を読み込めませんでした" error={err('NOT_FOUND')} onRetry={noop} />);
    expect(html).toContain('見つからないか閲覧権限がありません');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Not found.');
  });

  it('server messages are replaced by Japanese, overrides win', () => {
    expect(renderToString(<ResultError title="t" error={err('EXPIRED')} />)).toContain('有効期限が切れました');
    expect(renderToString(<ResultError title="t" error={err('UNAUTHENTICATED')} overrides={{ UNAUTHENTICATED: 'ログインIDまたはパスワードが違います。' }} />))
      .toContain('ログインIDまたはパスワードが違います');
  });
});

describe('U08 preview and detail (K12/K13/K14)', () => {
  it('preview shows what is public, the visibility with the group, and the removed fields', () => {
    const { snapshot } = mockSnapshot(domesticTrip);
    const html = renderToString(
      <PreviewView preview={{ previewToken: 'p'.repeat(20), snapshot, redactedFields: ['privateNotes', 'homeAddress', 'futureField'], expiresAt: '2026-10-25T00:10:00Z' }}
        visibility="group" groupName="金沢の仲間" story="楽しかった" />,
    );
    expect(html).toContain('公開される内容');
    expect(html).toContain('グループ');
    expect(html).toContain('金沢の仲間');
    expect(html).toContain('楽しかった');
    expect(html).toContain('私的なメモ');
    expect(html).toContain('自宅の住所');
    expect(html).toContain('futureField');
    expect(html).toContain(snapshot.title);
  });

  it('post detail never shows private notes, and unknown values are 未取得 (never 0)', async () => {
    const html = renderToString(<PostDetailView post={await samplePost()} />);
    expect(html).not.toContain('非公開メモ');
    expect(html).toContain('未取得');
    expect(html).not.toMatch(/[¥￥]0(?![\d,.])/);
  });

  it('copy result says re-validation is needed', async () => {
    const api = createMockSocialApi({ initialUser: 'demo-b' });
    const r = await api.copyPost('fx_post_1', { newStartDate: '2026-12-01', timeZone: 'Asia/Tokyo' });
    if (!r.ok) throw new Error('copy');
    expect(renderToString(<CopyResultView result={r.data} />)).toContain('再検証が必要');
    const trip = await api.getTrip(r.data.tripId);
    if (!trip.ok) throw new Error('trip');
    const html = renderToString(<CopiedTripView trip={trip.data} />);
    expect(html).toContain('新しい日付で再検証が必要です');
    expect(html).toContain('未取得');
  });
});

describe('U08 groups view (K17)', () => {
  it('empty state and role-based actions', () => {
    expect(renderToString(<GroupListView groups={[]} onInvite={noop} onLeave={noop} busy={false} />)).toContain('所属しているグループはありません');
    const html = renderToString(
      <GroupListView busy={false} onInvite={noop} onLeave={noop} groups={[
        { groupId: 'g1', name: '作ったグループ', role: 'owner', createdAt: '2026-10-24T00:00:00Z' },
        { groupId: 'g2', name: '参加したグループ', role: 'member', createdAt: '2026-10-24T00:00:00Z' },
      ]} />,
    );
    expect(html.match(/招待リンクを作る/g)).toHaveLength(1);
    expect(html.match(/このグループから抜ける/g)).toHaveLength(1);
  });
});

describe('U08 app shell', () => {
  it('mock mode is labelled MOCK; server mode is labelled SERVER', () => {
    const mock = renderToString(<SocialApp />);
    expect(mock).toContain('MOCK');
    expect(mock).toContain('フィード');
    expect(mock).toContain('グループ');
    const server = renderToString(<SocialApp initialMode="server" makeApi={() => createMockSocialApi()} />);
    expect(server).toContain('SERVER');
    expect(server).not.toContain('>MOCK<');
  });

  it('an invite link opens the invite screen', () => {
    const html = renderToString(<SocialApp inviteToken={'A'.repeat(43)} />);
    expect(html).toContain('グループへの招待');
  });

  it('navigation: tabs reset history, back returns, posted goes to the new post', () => {
    let s = initialNav();
    s = navReducer(s, { type: 'openPost', postId: 'p1', mine: false });
    expect(s.screen).toEqual({ name: 'post', postId: 'p1', mine: false });
    s = navReducer(s, { type: 'copied', result: { tripId: 't', ownerId: 'u', revision: 1, validationState: 'needs_revalidation' } });
    s = navReducer(s, { type: 'back' });
    expect(s.screen.name).toBe('post');
    s = navReducer(s, { type: 'back' });
    expect(s).toEqual(initialNav());
    expect(navReducer(s, { type: 'back' })).toBe(s);
    s = navReducer(navReducer(s, { type: 'tab', tab: 'compose' }), { type: 'posted', postId: 'p9' });
    expect(s.screen).toEqual({ name: 'post', postId: 'p9', mine: true });
    expect(initialNav('tok').screen).toEqual({ name: 'invite', token: 'tok' });
  });
});
