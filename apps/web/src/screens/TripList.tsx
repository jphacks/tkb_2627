import type { TripList as TripListData } from '@tkb/contracts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { SourceBadge } from '../components/SourceBadge.tsx';
import { VALIDATION_LABEL } from '../components/labels.ts';
import { ScreenHeader } from '../components/ScreenHeader.tsx';
import { useMockResult, type AsyncResult } from '../components/useMockResult.ts';
import { formatDay } from '../lib/format.ts';
import type { MockApi, MockResult } from '../mocks/index.ts';

/** Presentational: loading / error (with retry) / empty / list. */
export function TripListView({ state, onOpen, onRetry, onCreate }: {
  state: AsyncResult<TripListData>;
  onOpen: (tripId: string) => void;
  onRetry: () => void;
  onCreate: () => void;
}) {
  if (state.status === 'loading') return <p role="status" className="u1-loading">旅程を読み込み中…</p>;
  const result: MockResult<TripListData> = state.result;
  if (!result.ok) {
    return <ErrorBox title="旅程を読み込めませんでした" error={result.error} onRetry={onRetry} />;
  }
  const { items } = result.data;
  return (
    <>
      {items.length === 0 ? (
        <div className="u1-empty">
          <p><strong>まだ旅程がありません。</strong></p>
          <p>「新規作成」から条件を入力すると、候補が作られます。</p>
          <button type="button" className="btn u1-primary" onClick={onCreate}>旅程を新規作成する</button>
        </div>
      ) : (
        <ul className="u1-cards">
          {items.map(t => (
            <li key={t.tripId}>
              <button type="button" className="u1-card u1-cardbtn" onClick={() => onOpen(t.tripId)}>
                <span className="item-title">{t.title}</span>
                <span className="meta">{t.area} / {formatDay(t.startDate)} - {formatDay(t.endDate)}</span>
                <span className="meta">
                  <span className={`u1-state u1-state-${t.validationState}`}>{VALIDATION_LABEL[t.validationState]}</span>
                  {' '}版 {t.revision}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="u1-srcline"><SourceBadge result={result} /></p>
    </>
  );
}

export function TripList({ api, onOpen, onCreate }: { api: MockApi; onOpen: (tripId: string) => void; onCreate: () => void }) {
  const [state, reload] = useMockResult(() => api.listTrips(), api.scenario);
  return (
    <section aria-label="旅程の一覧">
      <ScreenHeader title="旅程" />
      <TripListView state={state} onOpen={onOpen} onRetry={reload} onCreate={onCreate} />
    </section>
  );
}
