import { useEffect, useReducer, useRef, useState } from 'react';
import type { ApiError, GenerateRequest, JobAccepted, PlanBatch, TripWriteResult } from '@tkb/contracts';
import { ErrorBox } from '../../components/ErrorBox.tsx';
import { MoneyTotals } from '../../components/MoneyText.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { JOB_STAGE_LABEL, JOB_STATE_LABEL, UNKNOWN_LABEL, VALIDATION_LABEL } from '../../components/labels.ts';
import { formatDuration } from '../../lib/format.ts';
import type { ApiResult } from '../conditions/api.ts';
import type { GenerateFlowApi } from './api.ts';
import {
  aiReasonMessage, applyErrorMessage, buildApplyRequest, canRetry, createRetryKeys, DATA_MODE_LABEL, initialPoll, modeChipLabel, type ModeCapState, jobErrorMessage, nextDelayMs, pollReducer, shouldPoll,
  summarizeCandidate, type CandidateSummary, type PollState,
} from './model.ts';
import './generate.css';

const errInfo = (e: ApiError, message: string) => ({ message, code: e.code, retryable: e.retryable, requestId: e.requestId });

/** LIVE banner: real data mode + AI availability from /local/v1/capabilities (never claims live data while loading or on error). */
export function LiveBanner({ state }: { state: ModeCapState }) {
  const tag = state.status === 'done' ? (state.dataMode === 'live' ? 'LIVE' : state.dataMode === 'mixed' ? 'MIXED' : 'FIXTURE') : '確認中';
  return (
    <div role="status" className="u1-banner" style={{ background: 'var(--accbg)' }}>
      <span className="u1-banner-tag" style={{ background: 'var(--acc)' }}>{tag}</span>
      <span>
        {state.status === 'done' ? `データ: ${DATA_MODE_LABEL[state.dataMode]}。` : `${modeChipLabel(state)}。`}
        {state.status === 'done' && !state.ai.available && ` ${aiReasonMessage(state.ai.reason)}（生成は実行できません）`}
        {state.status === 'done' && state.ai.available && '生成すると本人の生成ジョブが作られ、採用すると共有サーバーに旅程が保存されます。'}
      </span>
    </div>
  );
}

/** Small data-mode chip shown on the progress and compare screens (live source only). */
export function ModeChip({ state }: { state: ModeCapState }) {
  return <p className="meta u5-mode">データ: {modeChipLabel(state)}</p>;
}

export interface ProgressViewProps {
  poll: PollState;
  /** Cancel confirmation step: false = button, true = "are you sure". */
  confirming: boolean;
  cancelling: boolean;
  retrying: boolean;
  actionError: ApiError | null;
  onAskCancel: () => void;
  onConfirmCancel: () => void;
  onKeep: () => void;
  onRetry: () => void;
  onBack: () => void;
}

/** Presentational progress screen (K02 JobStatus). */
export function ProgressView(p: ProgressViewProps) {
  const { poll } = p;
  const job = poll.job;
  const failed = job?.state === 'failed' ? job.error : null;
  return (
    <section aria-label="生成の進捗">
      <ScreenHeader title="プランを生成中" onBack={p.onBack} />
      {poll.status === 'paused' && <p role="status" className="meta">画面が非表示のため状態の確認を一時停止しています。表示に戻ると再開します。</p>}
      {(poll.status === 'polling' || poll.status === 'paused') && (
        <div role="status" aria-live="polite" className="u5-progress">
          <p><strong>{job ? JOB_STATE_LABEL[job.state] : '状態を確認中…'}</strong>{job ? ` / ${JOB_STAGE_LABEL[job.stage]}` : ''}</p>
          <progress aria-label="生成の進行中" />
          {poll.lastError && <p className="meta">状態の確認に失敗しました。再確認しています（{poll.errors}/3）。</p>}
          {p.confirming ? (
            <div role="alertdialog" aria-label="取消の確認" className="note">
              <p>生成を取り消します。途中の結果は保存されません。よろしいですか。</p>
              <button type="button" className="btn" disabled={p.cancelling} onClick={p.onConfirmCancel}>{p.cancelling ? '取消中…' : '取り消す'}</button>{' '}
              <button type="button" className="btn" disabled={p.cancelling} onClick={p.onKeep}>続ける</button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={p.onAskCancel}>生成を取り消す</button>
          )}
        </div>
      )}
      {poll.status === 'terminal' && poll.cancelled && (
        <div role="status" className="note">
          <p>生成を取り消しました。</p>
          <button type="button" className="btn" disabled={p.retrying} onClick={p.onRetry}>{p.retrying ? '送信中…' : '同じ条件でもう一度生成'}</button>
        </div>
      )}
      {poll.status === 'terminal' && !poll.cancelled && job?.state === 'cancelled' && <p role="status">生成は取り消されました。</p>}
      {poll.status === 'terminal' && failed && (
        <ErrorBox
          title="生成に失敗しました"
          error={errInfo(failed, jobErrorMessage(failed))}
          {...(canRetry(failed) ? { onRetry: p.onRetry, retryLabel: p.retrying ? '送信中…' : '同じ条件で再試行' } : {})}
        />
      )}
      {poll.status === 'gave_up' && (
        <ErrorBox
          title="状態を確認できませんでした"
          error={poll.lastError ? errInfo(poll.lastError, jobErrorMessage(poll.lastError)) : { message: '一定時間内に完了を確認できませんでした。本人用アプリを確認してください。' }}
        />
      )}
      {p.actionError && <ErrorBox title="操作に失敗しました" error={errInfo(p.actionError, jobErrorMessage(p.actionError))} />}
    </section>
  );
}

/** Container: polls K02 with backoff, pauses while hidden, aborts on unmount, handles cancel (K21) and retry (K01). */
export function ProgressScreen({ api, accepted, request, onSucceeded, onRetried, onBack }: {
  api: GenerateFlowApi;
  accepted: JobAccepted;
  request: GenerateRequest;
  onSucceeded: (batchId: string) => void;
  /** The user pressed retry and the same request was accepted under a NEW idempotency key. */
  onRetried: (accepted: JobAccepted) => void;
  onBack: () => void;
}) {
  const [poll, dispatch] = useReducer(pollReducer, initialPoll);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const jobId = accepted.jobId;
  const retryKeys = useRef(createRetryKeys()).current;

  useEffect(() => {
    if (!shouldPoll(poll)) return undefined;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      void api.getJob(jobId, ac.signal).then(r => {
        if (ac.signal.aborted) return;
        dispatch(r.ok ? { type: 'result', job: r.data } : { type: 'error', error: r.error });
      });
    }, nextDelayMs(pollRef.current, accepted.pollAfterMs));
    return () => { clearTimeout(timer); ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- epoch/status capture every state change that needs rescheduling
  }, [poll.epoch, poll.status, api, jobId]);

  useEffect(() => {
    const onVis = () => dispatch({ type: document.hidden ? 'hidden' : 'visible' });
    if (document.hidden) onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const succeededBatch = poll.job?.state === 'succeeded' ? poll.job.batchId : null;
  useEffect(() => {
    if (succeededBatch) onSucceeded(succeededBatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per succeeded batch
  }, [succeededBatch]);

  const confirmCancel = async () => {
    setCancelling(true);
    setActionError(null);
    const r = await api.cancel(jobId);
    setCancelling(false);
    setConfirming(false);
    if (!r.ok) { setActionError(r.error); return; }
    if (r.data.state === 'cancelled') dispatch({ type: 'cancelled' });
    // Already finished on the server (succeeded/failed): the next poll shows the real outcome.
    else dispatch({ type: 'visible' });
  };

  const retry = async () => {
    setRetrying(true);
    setActionError(null);
    // Same key until a job id is obtained: a lost response + another press must not create a second job.
    const r = await api.generate(request, retryKeys.acquire());
    setRetrying(false);
    if (r.ok) { retryKeys.done(); onRetried(r.data); }
    else setActionError(r.error);
  };

  return (
    <ProgressView
      poll={poll} confirming={confirming} cancelling={cancelling} retrying={retrying} actionError={actionError}
      onAskCancel={() => setConfirming(true)} onConfirmCancel={() => void confirmCancel()} onKeep={() => setConfirming(false)}
      onRetry={() => void retry()} onBack={onBack}
    />
  );
}

export function SummaryCard({ summary, index, busy, onAdopt }: {
  summary: CandidateSummary;
  index: number;
  busy: boolean;
  onAdopt: (candidateId: string) => void;
}) {
  const s = summary;
  const details = s.warnings.length + s.reasons.length + s.excluded.length;
  return (
    <article className="u5-card" aria-labelledby={`u5-${s.candidateId}`}>
      <div className="u5-card-head">
        <h2 id={`u5-${s.candidateId}`} className="u1-cand-title">候補 {index + 1}：{s.title}</h2>
        <span className={`u1-state u1-state-${s.validationState}`}>{VALIDATION_LABEL[s.validationState]}</span>
      </div>
      <p className="meta">
        {s.days}日・予定 {s.activityCount}件・移動 {s.durationSeconds === null ? UNKNOWN_LABEL : formatDuration(s.durationSeconds)}
        {s.durationSeconds !== null && s.durationPartial ? '（一部不明）' : ''}
        ・既知の費用 <MoneyTotals totals={s.totals} />{s.hasUnknownCost ? `（${UNKNOWN_LABEL}の項目あり・0円ではありません）` : ''}
      </p>
      {details > 0 && (
        <details className="u1-details">
          <summary>詳しく（警告 {s.warnings.length}件・理由 {s.reasons.length}件・除外 {s.excluded.length}件）</summary>
          {s.warnings.length > 0 && <div className="note" aria-label="警告"><strong>警告</strong><ul>{s.warnings.map(w => <li key={w}>{w}</li>)}</ul></div>}
          {s.reasons.length > 0 && <><strong>この候補の理由</strong><ul>{s.reasons.map(r => <li key={r}>{r}</li>)}</ul></>}
          {s.excluded.length > 0 && (
            <><strong>除外された場所</strong>
              <ul>{s.excluded.map(x => <li key={x.placeId}>{x.name ?? `${UNKNOWN_LABEL}の場所（${x.placeId}）`}<br /><span className="meta">理由: {x.reason ?? `${UNKNOWN_LABEL}（記録なし）`}</span></li>)}</ul></>
          )}
        </details>
      )}
      <button type="button" className="btn u1-primary" disabled={busy || !s.adoptable} onClick={() => onAdopt(s.candidateId)}>
        {!s.adoptable ? '採用できません' : busy ? '処理中…' : 'この候補を採用'}
      </button>
      {!s.adoptable && <p className="meta">状態が「{VALIDATION_LABEL[s.validationState]}」の候補は採用できません。</p>}
    </article>
  );
}

export type BatchLoad = { status: 'loading' } | { status: 'done'; result: ApiResult<PlanBatch> };

export interface CompareViewProps {
  load: BatchLoad;
  busyId: string | null;
  applyError: ApiError | null;
  applied: TripWriteResult | null;
  /** Link target of the U04 map for the applied trip. */
  mapHref: string | null;
  onAdopt: (candidateId: string) => void;
  onReload: () => void;
  onBack: () => void;
}

/** Presentational: candidates stacked one per row, short, with the details folded (UI review on #33). */
export function CompareView(p: CompareViewProps) {
  return (
    <section aria-label="候補の比較">
      <ScreenHeader title="候補を比較" onBack={p.onBack} />
      {p.load.status === 'loading' && <p role="status" className="u1-loading">候補を読み込み中…</p>}
      {p.load.status === 'done' && !p.load.result.ok && (
        <ErrorBox title="候補を読み込めませんでした" error={errInfo(p.load.result.error, applyErrorMessage(p.load.result.error))} onRetry={p.onReload} />
      )}
      {p.load.status === 'done' && p.load.result.ok && (() => {
        const batch = p.load.result.data;
        const sums = batch.candidates.slice(0, 3).map(c => summarizeCandidate(c, batch.places));
        return sums.length === 0 ? (
          <div className="u1-empty"><p>候補がありません。条件を変えてもう一度お試しください。</p></div>
        ) : (
          <div className="u5-grid" role="group" aria-label="候補の比較">
            {sums.map((s, i) => <SummaryCard key={s.candidateId} summary={s} index={i} busy={p.busyId !== null || p.applied !== null} onAdopt={p.onAdopt} />)}
          </div>
        );
      })()}
      {p.applyError && <ErrorBox title="採用できませんでした" error={errInfo(p.applyError, applyErrorMessage(p.applyError))} />}
      {p.applied && (
        <div role="status" className="note u5-done">
          <p><strong>採用しました。</strong> 旅程ID: {p.applied.tripId}（版 {p.applied.revision}）</p>
          {p.applied.warnings.length > 0 && <ul>{p.applied.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
          {p.mapHref && <a className="btn u1-primary" href={p.mapHref}>地図で旅程を開く</a>}
        </div>
      )}
    </section>
  );
}

export function CompareScreen({ api, batchId, mapHrefFor, onApplied, onBack, onBatchLoaded }: {
  api: GenerateFlowApi;
  batchId: string;
  mapHrefFor: (tripId: string) => string;
  /** Called with the map link once the candidate is saved (the app opens the map). The link stays as a fallback. */
  onApplied?: (mapHref: string) => void;
  onBack: () => void;
  /** Called with the loaded batch (U04 preview under the form). */
  onBatchLoaded?: (batch: PlanBatch) => void;
}) {
  const [load, setLoad] = useState<BatchLoad>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<ApiError | null>(null);
  const [applied, setApplied] = useState<TripWriteResult | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoad({ status: 'loading' });
    void api.getBatch(batchId, ac.signal).then(result => {
      if (ac.signal.aborted) return;
      setLoad({ status: 'done', result });
      if (result.ok) onBatchLoaded?.(result.data);
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callback only reports the loaded batch
  }, [api, batchId, reloadKey]);

  const adopt = async (candidateId: string) => {
    setBusyId(candidateId);
    setApplyError(null);
    const r = await api.apply(buildApplyRequest(batchId, candidateId));
    setBusyId(null);
    if (r.ok) {
      setApplied(r.data);
      onApplied?.(mapHrefFor(r.data.tripId));
    } else setApplyError(r.error);
  };

  return (
    <CompareView
      load={load} busyId={busyId} applyError={applyError} applied={applied}
      mapHref={applied ? mapHrefFor(applied.tripId) : null}
      onAdopt={id => void adopt(id)} onReload={() => setReloadKey(k => k + 1)} onBack={onBack}
    />
  );
}
