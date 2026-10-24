import { useState } from 'react';
import type { Feed as FeedData, Trip, Visibility } from '@tkb/contracts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { ScreenHeader } from '../components/ScreenHeader.tsx';
import { SourceBadge } from '../components/SourceBadge.tsx';
import { TRANSPORT_LABEL, VISIBILITY_LABEL } from '../components/labels.ts';
import { useMockResult, type AsyncResult } from '../components/useMockResult.ts';
import { formatDay } from '../lib/format.ts';
import type { MockApi, MockResult } from '../mocks/index.ts';

const SCOPES: Visibility[] = ['private', 'group', 'public'];

const SCOPE_HELP: Record<Visibility, string> = {
  private: '自分だけが見られます。フィードには出ません。',
  group: '選んだグループのメンバーだけが見られます（グループ選択は未接続）。',
  public: '誰でもフィードで見られます。',
};

/** What would be visible to others (allow-list view: no budget, no departure/return, no private notes). */
export function SharePreview({ trip, visibility }: { trip: Trip; visibility: Visibility }) {
  return (
    <article className="u1-card" aria-label="共有時の表示プレビュー">
      <p className="meta">共有範囲: {VISIBILITY_LABEL[visibility]}</p>
      <h3 className="u1-cand-title">{trip.title}</h3>
      <p className="meta">
        {trip.constraints.area} / {formatDay(trip.constraints.startDate)} - {formatDay(trip.constraints.endDate)} / {TRANSPORT_LABEL[trip.constraints.transportMode]}
      </p>
      {trip.days.map((day, i) => (
        <div key={day.date}>
          <h4 className="u1-dayhead">{i + 1}日目 {formatDay(day.date)}</h4>
          <ul>
            {day.items.map(item =>
              item.type === 'activity' ? (
                <li key={item.activityId}>{item.title}（費用 <MoneyText money={item.cost} />）</li>
              ) : (
                <li key={item.legId} className="meta">移動（{item.mode === 'transit' ? '公共交通' : item.mode === 'car' ? '車' : '徒歩'}）</li>
              ),
            )}
          </ul>
        </div>
      ))}
      <p className="meta">表示されない情報: 予算、出発地・帰着地、私的なメモ。写真は含めません。</p>
    </article>
  );
}

export function ShareView({ trip }: { trip: Trip }) {
  const [visibility, setVisibility] = useState<Visibility>('private');
  return (
    <>
      <p className="note" role="note">これはモックです。ここで選んでも何も投稿・保存されません（画面の見た目の確認用）。</p>
      <fieldset className="u1-field u1-fieldset">
        <legend>共有範囲</legend>
        {SCOPES.map(s => (
          <label key={s} className="u1-choice">
            <input type="radio" name="s-scope" value={s} checked={visibility === s} onChange={() => setVisibility(s)} />
            <span>
              <strong>{VISIBILITY_LABEL[s]}</strong>
              <span className="meta">{SCOPE_HELP[s]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <h2 className="u1-sub">共有時の表示プレビュー</h2>
      <SharePreview trip={trip} visibility={visibility} />
    </>
  );
}

export function Share({ api, tripId, onBack }: { api: MockApi; tripId: string; onBack: () => void }) {
  const [state, reload] = useMockResult(() => api.getTrip(tripId), tripId);
  return (
    <section aria-label="共有">
      <ScreenHeader title="共有" onBack={onBack} />
      {state.status === 'loading' ? (
        <p role="status" className="u1-loading">旅程を読み込み中…</p>
      ) : !state.result.ok ? (
        <ErrorBox title="旅程を読み込めませんでした" error={state.result.error} onRetry={reload} />
      ) : (
        <>
          <ShareView trip={state.result.data} />
          <p className="u1-srcline"><SourceBadge result={state.result} /></p>
        </>
      )}
    </section>
  );
}

/** Presentational feed: loading / error / empty / posts. */
export function FeedView({ state, onRetry }: { state: AsyncResult<FeedData>; onRetry: () => void }) {
  if (state.status === 'loading') return <p role="status" className="u1-loading">フィードを読み込み中…</p>;
  const result: MockResult<FeedData> = state.result;
  if (!result.ok) return <ErrorBox title="フィードを読み込めませんでした" error={result.error} onRetry={onRetry} />;
  return (
    <>
      {result.data.items.length === 0 ? (
        <div className="u1-empty"><p><strong>公開された旅程はまだありません。</strong></p></div>
      ) : (
        <ul className="u1-cards">
          {result.data.items.map(p => (
            <li key={p.postId}>
              <article className="u1-card">
                <h2 className="u1-cand-title">{p.title}</h2>
                <p className="meta">{p.authorDisplayName} / {p.area} / {formatDay(p.startDate)}〜 / {VISIBILITY_LABEL[p.visibility]}</p>
                <p>{p.story}</p>
              </article>
            </li>
          ))}
        </ul>
      )}
      <p className="u1-srcline"><SourceBadge result={result} /></p>
    </>
  );
}

export function Feed({ api }: { api: MockApi }) {
  const [state, reload] = useMockResult(() => api.getFeed({ scope: 'public' }), api.scenario);
  return (
    <section aria-label="フィード">
      <ScreenHeader title="フィード（公開）" />
      <p className="note" role="note">モックのデータです。実際の投稿ではありません。</p>
      <FeedView state={state} onRetry={reload} />
    </section>
  );
}
