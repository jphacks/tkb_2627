import type { Activity, Trip } from '@tkb/contracts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { ScreenHeader } from '../components/ScreenHeader.tsx';
import { SourceBadge } from '../components/SourceBadge.tsx';
import { UNKNOWN_LABEL } from '../components/labels.ts';
import { useMockResult } from '../components/useMockResult.ts';
import { formatDay, formatZoned } from '../lib/format.ts';
import type { MockApi } from '../mocks/index.ts';
import { pickGuideTarget, type GuideDayReason } from './guide.ts';

const REASON_TEXT: Record<GuideDayReason, string> = {
  today: '今日の旅程です。',
  upcoming: '今日は旅程の日ではありません。次に来る日を表示しています。',
  past: 'この旅程の日程は終了しています。最後の日を表示しています。',
  none: 'この旅程には日程がありません。',
};

function ActivityCard({ activity, trip, heading }: { activity: Activity; trip: Trip; heading: string }) {
  const place = activity.placeId ? trip.places.find(p => p.placeId === activity.placeId) : undefined;
  return (
    <article className="u1-card">
      <p className="meta">{heading}</p>
      <h3 className="u1-cand-title">{activity.title}</h3>
      <p className="meta">開始 {formatZoned(activity.start)}</p>
      <p className="meta">終了 {formatZoned(activity.end)}</p>
      <p className="meta">費用 <MoneyText money={activity.cost} /></p>
      {activity.kind === 'free_walk' && <p className="meta">エリア: {activity.areaName ?? UNKNOWN_LABEL}（店・施設は未指定）</p>}
      {place && (
        <p className="meta">
          場所: {place.name} / 営業時間: {place.openingHours ?? UNKNOWN_LABEL}
          <br />
          出典: {place.provenance.source}{place.provenance.attribution ? `（${place.provenance.attribution}）` : ''}
        </p>
      )}
    </article>
  );
}

/** Entry point only: the next planned item, taken from the trip. No geolocation API is used. */
export function GuideView({ trip, now }: { trip: Trip; now: Date }) {
  const target = pickGuideTarget(trip, now);
  return (
    <>
      <h2 className="u1-sub">{trip.title}</h2>
      <p>{REASON_TEXT[target.reason]}{target.day && <span className="meta"> {formatDay(target.day.date)}（{target.day.timeZone}）</span>}</p>

      {target.next ? (
        <ActivityCard activity={target.next} trip={trip} heading="次の予定" />
      ) : (
        <div className="u1-empty"><p>この日に残っている予定はありません。</p></div>
      )}
      {target.following && <ActivityCard activity={target.following} trip={trip} heading="その次の予定" />}

      <div className="u1-location" aria-label="現在地の状態">
        <strong>現在地は未接続</strong>
        <p className="meta">
          位置情報は使っていません（ブラウザの位置情報APIは呼び出していません）。現在地に基づく案内や再計画は、接続後に追加されます。
          位置情報を許可しない場合でも、このガイドは旅程の時刻だけで使えます。
        </p>
      </div>
    </>
  );
}

export function Guide({ api, tripId, onBack }: { api: MockApi; tripId: string; onBack: () => void }) {
  const [state, reload] = useMockResult(() => api.getTrip(tripId), tripId);
  return (
    <section aria-label="ガイド">
      <ScreenHeader title="ガイド" onBack={onBack} />
      {state.status === 'loading' ? (
        <p role="status" className="u1-loading">旅程を読み込み中…</p>
      ) : !state.result.ok ? (
        <ErrorBox title="旅程を読み込めませんでした" error={state.result.error} onRetry={reload} />
      ) : (
        <>
          <GuideView trip={state.result.data} now={new Date()} />
          <p className="u1-srcline"><SourceBadge result={state.result} /></p>
        </>
      )}
    </section>
  );
}
