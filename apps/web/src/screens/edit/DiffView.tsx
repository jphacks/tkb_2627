import type { ApiError, TripDiff } from '@tkb/contracts';
import { CONFLICT_MESSAGE, describeEditError, isRevisionConflict } from './api.ts';
import { describeDiff } from './ops.ts';
import './edit.css';

/** R11: duration and cost differences. Unknown cost items are named as 費用不明 and never counted as 0. */
export function DiffView({ diff, titleOf, heading = '変更前後の差分' }: { diff: TripDiff; titleOf: (id: string) => string; heading?: string }) {
  const d = describeDiff(diff, titleOf);
  return (
    <dl className="ed-diff" aria-label={heading}>
      <dt>所要時間の差</dt>
      <dd className={diff.durationDeltaSeconds === null ? 'u1-unknown' : undefined}>{d.duration}</dd>
      <dt>費用の差（金額が分かるもの）</dt>
      <dd>{d.costs.length > 0 ? d.costs.join(' / ') : '差なし（金額が分かる範囲）'}</dd>
      {d.unknownCostTitles.length > 0 && (
        <>
          <dt>費用不明</dt>
          <dd className="u1-unknown">{d.unknownCostTitles.map(t => `${t}（費用不明）`).join('、')}（差額には含めていません）</dd>
        </>
      )}
    </dl>
  );
}

/** Error with a reload action for 409; a conflict never offers "retry with the same version". */
export function EditError({ error, onReload, onDismiss }: { error: ApiError; onReload: () => void; onDismiss?: () => void }) {
  const conflict = isRevisionConflict(error);
  return (
    <div role="alert" className="u1-error">
      <strong>{conflict ? CONFLICT_MESSAGE : '操作できませんでした'}</strong>
      <p>{describeEditError(error)}</p>
      <p className="meta">コード: {error.code}{error.requestId ? ` / リクエストID: ${error.requestId}` : ''}</p>
      {conflict && <button type="button" className="btn u1-primary" onClick={onReload}>最新の旅程を再読み込み</button>}
      {!conflict && onDismiss && <button type="button" className="btn" onClick={onDismiss}>閉じる</button>}
    </div>
  );
}

export const TRAVEL_LABEL = { known: '移動あり', none: '移動なし', unknown: '移動時間は不明' } as const;
export const NO_OPERATIONS_REASON = 'この案は保存できる操作に変換できないため、適用できません（表示のみ）。';
