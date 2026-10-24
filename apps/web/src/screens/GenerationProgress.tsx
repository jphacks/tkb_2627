import { useEffect, useRef, useState } from 'react';
import { TERMINAL_JOB_STATES } from '@tkb/contracts';
import type { ApiError, CancelResult, JobStage, JobState, JobStatus } from '@tkb/contracts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { JOB_STAGE_LABEL, JOB_STATE_LABEL } from '../components/labels.ts';
import { ScreenHeader } from '../components/ScreenHeader.tsx';
import { thrownToError } from '../components/useMockResult.ts';
import type { MockApi } from '../mocks/index.ts';

const STEPS: JobStage[] = ['queued', 'collecting_context', 'generating', 'validating', 'saved'];

function stepIndex(stage: JobStage): number {
  if (stage === 'saving') return 4;
  if (stage === 'done') return 4;
  return STEPS.indexOf(stage);
}

export interface ProgressViewProps {
  state: JobState;
  stage: JobStage | null;
  batchId: string | null;
  jobError: JobStatus['error'];
  pollError: ApiError | null;
  /** Message after a cancel request (e.g. already saved). */
  note: string | null;
  cancelError: ApiError | null;
  cancelling: boolean;
  polls: number;
  onCancel: () => void;
  onResume: () => void;
  onOpenCandidates: (batchId: string) => void;
  onBackToConditions: () => void;
}

/** Presentational: visible job state, stage, cancel, and the outcome of each terminal state. */
export function ProgressView(p: ProgressViewProps) {
  const terminal = TERMINAL_JOB_STATES.includes(p.state);
  const current = p.stage ? stepIndex(p.stage) : 0;
  return (
    <>
      <p className="u1-jobstate" role="status" aria-live="polite">
        状態: <strong className={`u1-job u1-job-${p.state}`}>{JOB_STATE_LABEL[p.state]}</strong>
        {p.stage && <span className="meta"> 段階: {JOB_STAGE_LABEL[p.stage]}</span>}
        <span className="meta"> 状態確認 {p.polls} 回</span>
      </p>

      <ol className="u1-steps" aria-label="生成の段階">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={!terminal && i === current ? 'step' : undefined}
            className={i < current || (p.state === 'succeeded' && i <= current) ? 'u1-step-done' : i === current ? 'u1-step-now' : ''}>
            {JOB_STAGE_LABEL[s]}
          </li>
        ))}
      </ol>

      {p.pollError && <ErrorBox title="状態を取得できませんでした" error={p.pollError} onRetry={p.onResume} retryLabel="状態確認を再開" />}
      {p.note && <p className="note" role="status">{p.note}</p>}
      {p.cancelError && <ErrorBox title="取消できませんでした" error={p.cancelError} />}

      {p.state === 'succeeded' && p.batchId && (
        <div className="u1-ok">
          <p><strong>候補ができました。</strong></p>
          <button type="button" className="btn u1-primary" onClick={() => p.onOpenCandidates(p.batchId as string)}>候補を比較する</button>
        </div>
      )}
      {p.state === 'failed' && (
        <>
          <ErrorBox title="生成に失敗しました" error={p.jobError ?? { message: '原因は不明です。' }} />
          <button type="button" className="btn u1-primary" onClick={p.onBackToConditions}>条件を直して再試行</button>
        </>
      )}
      {p.state === 'cancelled' && (
        <div className="u1-empty">
          <p>生成を取り消しました。何も保存されていません。</p>
          <button type="button" className="btn u1-primary" onClick={p.onBackToConditions}>条件入力に戻る</button>
        </div>
      )}
      {!terminal && (
        <>
          <button type="button" className="btn" onClick={p.onCancel} disabled={p.cancelling}>
            {p.cancelling ? '取消中…' : '取消'}
          </button>
          <p className="meta">この画面を離れると（戻る・タブの切替）、生成を取り消します。</p>
        </>
      )}
    </>
  );
}

export function GenerationProgress({ api, jobId, pollAfterMs, onSucceeded, onBack }: {
  api: MockApi;
  jobId: string;
  pollAfterMs: number;
  onSucceeded: (batchId: string) => void;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [pollError, setPollError] = useState<ApiError | null>(null);
  const [polls, setPolls] = useState(0);
  const [resume, setResume] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  // Outcome of an accepted cancel request (200/202): cancelled, or already succeeded/failed.
  const [cancelOutcome, setCancelOutcome] = useState<CancelResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<ApiError | null>(null);
  const stopped = useRef(false);
  // Last known: the job may still be queued/running. Cleared once it is observed finished or cancelled.
  const active = useRef(true);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Leaving this screen (戻る, tab switch, restart) must not orphan a queued/running job: cancel it.
  // The cancel is deferred one tick and cleared on re-mount, so React StrictMode's simulated
  // unmount/mount does not cancel a job that is still being watched. Finished jobs are never cancelled.
  useEffect(() => {
    if (leaveTimer.current !== undefined) clearTimeout(leaveTimer.current);
    return () => {
      leaveTimer.current = setTimeout(() => {
        if (active.current) {
          active.current = false;
          void api.cancelJob(jobId).catch(() => undefined); // the result is intentionally not shown
        }
      }, 0);
    };
  }, [api, jobId]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let r: Awaited<ReturnType<typeof api.getJob>>;
      try {
        r = await api.getJob(jobId);
      } catch (e) {
        if (live) setPollError(thrownToError(e));
        return;
      }
      // Track the job's state even when this poll arrives after the screen was left.
      if (r.ok && TERMINAL_JOB_STATES.includes(r.data.state)) active.current = false;
      if (!live) return;
      setPolls(n => n + 1);
      if (!r.ok) {
        setPollError(r.error); // stop; the user resumes explicitly
        return;
      }
      setPollError(null);
      setStatus(r.data);
      if (TERMINAL_JOB_STATES.includes(r.data.state) || stopped.current) return;
      timer = setTimeout(() => void run(), Math.max(100, pollAfterMs));
    };
    void run();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, jobId, pollAfterMs, resume]);

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    setNote(null);
    try {
      const r = await api.cancelJob(jobId);
      if (r.ok) {
        // 200 (already finished) and 202 (cancel accepted) are both success responses.
        if (TERMINAL_JOB_STATES.includes(r.data.state)) active.current = false;
        if (r.data.state === 'cancelled' || (r.data.state === 'succeeded' && r.data.batchId !== null)) {
          stopped.current = true;
          setCancelOutcome(r.data);
          if (r.data.state === 'succeeded') setNote('取り消す前に生成が完了していました。候補を比較できます。');
        }
      } else if (r.status === 409) {
        // 409: saving is in progress, so the result is not decided yet. Keep polling.
        setNote('保存処理が進行中のため取り消せませんでした。結果はまだ確定していません。状態確認を続けます。');
        // If polling had stopped on an error, resume it so the note is true.
        if (pollError) {
          setPollError(null);
          setResume(n => n + 1);
        }
      } else {
        setCancelError(r.error);
      }
    } catch (e) {
      setCancelError(thrownToError(e));
    } finally {
      setCancelling(false);
    }
  };

  const state: JobState = cancelOutcome?.state === 'cancelled' || cancelOutcome?.state === 'succeeded' ? cancelOutcome.state : (status?.state ?? 'queued');
  return (
    <section aria-label="生成の進行状況">
      <ScreenHeader title="候補を生成しています" onBack={onBack} />
      <ProgressView
        state={state}
        stage={status?.stage ?? null}
        batchId={status?.batchId ?? cancelOutcome?.batchId ?? null}
        jobError={status?.error ?? null}
        pollError={pollError}
        note={note}
        cancelError={cancelError}
        cancelling={cancelling}
        polls={polls}
        onCancel={() => void cancel()}
        onResume={() => setResume(n => n + 1)}
        onOpenCandidates={onSucceeded}
        onBackToConditions={onBack}
      />
    </section>
  );
}
