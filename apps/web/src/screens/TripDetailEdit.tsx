import { useState } from 'react';
import type { ApiError, ItineraryItem, Trip, TripDiff, TripOperation } from '@tkb/contracts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { MoneyDeltaText } from '../components/MoneyText.tsx';
import { ScreenHeader } from '../components/ScreenHeader.tsx';
import { SourceBadge } from '../components/SourceBadge.tsx';
import { UNKNOWN_LABEL, VALIDATION_LABEL } from '../components/labels.ts';
import { thrownToError, useMockResult } from '../components/useMockResult.ts';
import { formatDay, formatDuration } from '../lib/format.ts';
import type { MockApi, MockResult } from '../mocks/index.ts';
import { TripViewer } from '../shell/TripViewer.tsx';

export function itemIdOf(item: ItineraryItem): string {
  return item.type === 'activity' ? item.activityId : item.legId;
}

function itemLabel(item: ItineraryItem, trip: Trip): string {
  if (item.type === 'activity') return item.title;
  const name = (id: string) => trip.places.find(p => p.placeId === id)?.name ?? UNKNOWN_LABEL;
  return `移動: ${name(item.fromPlaceId)} → ${name(item.toPlaceId)}`;
}

/** Result of K10: duration delta null is 未取得, unknown-cost items are listed and never counted as 0. */
export function DiffView({ diff, trip, before }: { diff: TripDiff; trip: Trip; /** The trip before the patch, to name removed items. */ before?: Trip }) {
  const labels = (t: Trip) => new Map(t.days.flatMap(d => d.items).map(i => [itemIdOf(i), itemLabel(i, t)]));
  const afterLabels = labels(trip);
  const beforeLabels = before ? labels(before) : new Map<string, string>();
  const labelOf = (id: string): string => {
    const now = afterLabels.get(id);
    if (now !== undefined) return now;
    const old = beforeLabels.get(id);
    return old !== undefined ? `${old}（削除済み）` : `${id}（削除済み）`;
  };
  const d = diff.durationDeltaSeconds;
  return (
    <section className="u1-diff" aria-label="直前の変更の差分">
      <h3>直前の変更の差分</h3>
      <dl>
        <dt>所要時間の変化</dt>
        <dd>
          {d === null
            ? `${UNKNOWN_LABEL}（所要時間が未取得の予定を含むため算出できません）`
            : d === 0
              ? '変化なし'
              : `${d > 0 ? '+' : '-'}${formatDuration(Math.abs(d))}`}
        </dd>
        <dt>既知の費用の増減</dt>
        <dd>
          {diff.knownCostDelta.length === 0 ? (
            '変化なし（金額が分かっている項目のみ）'
          ) : (
            <ul>{diff.knownCostDelta.map(m => <li key={m.currency}><MoneyDeltaText money={m} /></li>)}</ul>
          )}
        </dd>
        <dt>費用が{UNKNOWN_LABEL}の項目</dt>
        <dd>
          {diff.unknownCostItems.length === 0 ? (
            'なし'
          ) : (
            <>
              <span>{diff.unknownCostItems.length}件（0円として扱っていません）</span>
              <ul>{diff.unknownCostItems.map(id => <li key={id}>{labelOf(id)}</li>)}</ul>
            </>
          )}
        </dd>
      </dl>
    </section>
  );
}

/** Edit controls: rename, remove, move up/down. Each sends one K10 patch with the loaded revision. */
export function EditPanel({ trip, saving, locked = false, titleDraft, onTitleDraft, onPatch }: {
  trip: Trip;
  saving: boolean;
  /** True after a REVISION_CONFLICT: editing stays off until the user reloads. */
  locked?: boolean;
  titleDraft: string;
  onTitleDraft: (v: string) => void;
  onPatch: (ops: TripOperation[]) => void;
}) {
  const off = saving || locked;
  const titleChanged = titleDraft.trim() !== '' && titleDraft.trim() !== trip.title;
  return (
    <section className="u1-edit" aria-label="旅程の編集">
      <h3>編集（版 {trip.revision}）</h3>
      {locked && <p className="note">旅程が別の場所で更新されたため、編集を止めています。「再読込」で最新の旅程を読み込んでください。</p>}
      <div className="u1-field">
        <label htmlFor="e-title">タイトル</label>
        <input id="e-title" type="text" value={titleDraft} maxLength={200} onChange={e => onTitleDraft(e.target.value)} />
        <button type="button" className="btn" disabled={off || !titleChanged}
          onClick={() => onPatch([{ op: 'set_title', title: titleDraft.trim() }])}>
          タイトルを変更
        </button>
      </div>

      {trip.days.map((day, dayIndex) => (
        <div key={day.date}>
          <h4 className="u1-dayhead">{dayIndex + 1}日目 {formatDay(day.date)}</h4>
          <ul className="u1-editlist">
            {day.items.map((item, i) => {
              const id = itemIdOf(item);
              const label = itemLabel(item, trip);
              return (
                <li key={id} className="u1-edititem">
                  <span className="u1-editlabel">{label}</span>
                  <span className="u1-editbtns">
                    <button type="button" className="btn" disabled={off || i === 0} aria-label={`「${label}」を上へ移動`}
                      onClick={() => onPatch([{ op: 'move', itemId: id, toDayIndex: dayIndex, toPosition: i - 1 }])}>上へ</button>
                    <button type="button" className="btn" disabled={off || i === day.items.length - 1} aria-label={`「${label}」を下へ移動`}
                      onClick={() => onPatch([{ op: 'move', itemId: id, toDayIndex: dayIndex, toPosition: i + 1 }])}>下へ</button>
                    <button type="button" className="btn u1-danger" disabled={off} aria-label={`「${label}」を削除`}
                      onClick={() => onPatch([{ op: 'remove', itemId: id }])}>削除</button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** REVISION_CONFLICT: nothing was saved; the user chooses to reload (never overwritten silently). */
export function ConflictNotice({ error, onReload }: { error: ApiError; onReload: () => void }) {
  return (
    <div role="alert" className="u1-error">
      <strong>別の場所で旅程が更新されています</strong>
      <p>あなたの変更は保存していません（相手の変更を上書きしないため）。最新の旅程を再読込してから、もう一度編集してください。</p>
      <p className="meta">コード: {error.code} / リクエストID: {error.requestId}</p>
      <button type="button" className="btn u1-primary" onClick={onReload}>再読込</button>
    </div>
  );
}

export function TripDetailEdit({ api, tripId, onBack, onGuide, onShare }: {
  api: MockApi;
  tripId: string;
  onBack: () => void;
  onGuide: () => void;
  onShare: () => void;
}) {
  const [loaded, reload] = useMockResult(() => api.getTrip(tripId), tripId);
  return (
    <section aria-label="旅程の詳細">
      <ScreenHeader title="旅程の詳細" onBack={onBack} />
      {loaded.status === 'loading' ? (
        <p role="status" className="u1-loading">旅程を読み込み中…</p>
      ) : !loaded.result.ok ? (
        <ErrorBox title="旅程を読み込めませんでした" error={loaded.result.error} onRetry={reload} />
      ) : (
        <DetailBody key={`${loaded.result.data.tripId}:${loaded.result.data.revision}`} api={api} result={loaded.result}
          onReload={reload} onGuide={onGuide} onShare={onShare} />
      )}
    </section>
  );
}

function DetailBody({ api, result, onReload, onGuide, onShare }: {
  api: MockApi;
  result: MockResult<Trip> & { ok: true };
  onReload: () => void;
  onGuide: () => void;
  onShare: () => void;
}) {
  const [edited, setEdited] = useState<Trip | null>(null);
  const trip = edited ?? result.data;
  const [diff, setDiff] = useState<{ diff: TripDiff; before: Trip } | null>(null);
  const [saving, setSaving] = useState(false);
  const [patchError, setPatchError] = useState<ApiError | null>(null);
  const [titleDraft, setTitleDraft] = useState(result.data.title);

  const patch = async (operations: TripOperation[]) => {
    setSaving(true);
    setPatchError(null);
    try {
      const r = await api.patchTrip(trip.tripId, { expectedRevision: trip.revision, operations });
      if (r.ok) {
        setDiff({ diff: r.data.diff, before: trip });
        setEdited(r.data.trip);
        setTitleDraft(r.data.trip.title);
      } else {
        setPatchError(r.error);
      }
    } catch (e) {
      setPatchError(thrownToError(e));
    } finally {
      setSaving(false);
    }
  };

  /** Reviewer aid: another device changes the trip, this screen stays on the old revision. */
  const simulateOtherDevice = async () => {
    setSaving(true);
    try {
      const r = await api.patchTrip(trip.tripId, {
        expectedRevision: trip.revision,
        operations: [{ op: 'set_title', title: `${trip.title.replace(/（別端末で更新）$/, '')}（別端末で更新）` }],
      });
      if (!r.ok) setPatchError(r.error);
    } catch (e) {
      setPatchError(thrownToError(e));
    } finally {
      setSaving(false);
    }
  };

  const conflict = patchError?.code === 'REVISION_CONFLICT';

  const reloadLatest = () => {
    setEdited(null);
    setDiff(null);
    setPatchError(null);
    onReload();
  };

  return (
    <>
      <p>
        <span className={`u1-state u1-state-${trip.validationState}`}>{VALIDATION_LABEL[trip.validationState]}</span>
        <span className="meta"> 版 {trip.revision} / {trip.constraints.area}</span>
      </p>
      {trip.validationState === 'needs_revalidation' && (
        <p className="note">予定を変更したため、移動時間や到着時刻が古い可能性があります（再検証が必要）。</p>
      )}
      {trip.warnings.length > 0 && (
        <div className="note"><strong>警告</strong><ul>{trip.warnings.map(w => <li key={w}>{w}</li>)}</ul></div>
      )}

      <div className="u1-actions">
        <button type="button" className="btn u1-primary" onClick={onGuide}>ガイドを開く</button>
        <button type="button" className="btn" onClick={onShare}>共有する</button>
      </div>

      <TripViewer trips={[trip]} />

      {conflict && patchError ? (
        <ConflictNotice error={patchError} onReload={reloadLatest} />
      ) : (
        patchError && <ErrorBox title="変更を保存できませんでした" error={patchError} />
      )}
      {diff && <DiffView diff={diff.diff} trip={trip} before={diff.before} />}

      <EditPanel trip={trip} saving={saving} locked={conflict} titleDraft={titleDraft} onTitleDraft={setTitleDraft} onPatch={ops => void patch(ops)} />

      <details className="u1-review u1-details">
        <summary>レビュー用: 競合の再現</summary>
        <p className="meta">別の端末が先に更新した状況を作ります。この後に編集すると REVISION_CONFLICT になります（モックのみ）。</p>
        <button type="button" className="btn" disabled={saving || conflict} onClick={() => void simulateOtherDevice()}>別端末の更新を再現</button>
      </details>

      <p className="u1-srcline"><SourceBadge result={result} /></p>
    </>
  );
}
