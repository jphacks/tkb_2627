import type { MockApi } from '../mocks/index.ts';
import type { ErrorInfo } from '../components/ErrorBox.tsx';

/** What actually happened to each job the user asked to cancel (the server may have finished it first). */
export interface CancelOutcome {
  /** 202: the cancel was accepted. */
  cancelled: string[];
  /** 200 {state: succeeded}: it had already finished, its candidates exist. Not discarded. */
  alreadySucceeded: string[];
  /** 200 {state: failed}: it had already failed, nothing was created. */
  alreadyFailed: string[];
  /** 404: the job no longer exists. */
  gone: string[];
}

export const emptyOutcome = (): CancelOutcome => ({ cancelled: [], alreadySucceeded: [], alreadyFailed: [], gone: [] });

/**
 * Explicit cancel of the given jobs (the 取り消して新しく作る button). The reply decides what is true:
 * only cancelled / gone / failed jobs are forgotten; a job that turned out to be succeeded is kept and reported
 * as finished, so its saved candidates stay reachable. Stops at the first unexpected error (e.g. 409 saving).
 */
export async function cancelJobs(
  api: Pick<MockApi, 'cancelJob'>,
  jobs: { jobId: string }[],
  on: { ended: (jobId: string) => void; succeeded: (jobId: string) => void },
): Promise<{ outcome: CancelOutcome; error: ErrorInfo | null }> {
  const outcome = emptyOutcome();
  for (const { jobId } of jobs) {
    const r = await api.cancelJob(jobId);
    if (!r.ok) {
      if (r.status === 404) {
        outcome.gone.push(jobId);
        on.ended(jobId);
        continue;
      }
      return { outcome, error: r.error };
    }
    switch (r.data.state) {
      case 'succeeded':
        outcome.alreadySucceeded.push(jobId);
        on.succeeded(jobId);
        break;
      case 'failed':
        outcome.alreadyFailed.push(jobId);
        on.ended(jobId);
        break;
      case 'cancelled':
        outcome.cancelled.push(jobId);
        on.ended(jobId);
        break;
      default:
        // queued / running in a cancel reply is not a defined outcome: keep the job and say so.
        return { outcome, error: { message: 'ジョブの状態を確認できませんでした。続きを確認してください。', code: 'INTERNAL' } };
    }
  }
  return { outcome, error: null };
}

/** User-visible sentences for a cancel outcome. A cancel is only reported when it actually happened. */
export function cancelOutcomeMessages(o: CancelOutcome): string[] {
  const messages: string[] = [];
  if (o.cancelled.length > 0) messages.push('生成を取り消しました。何も保存されていません。');
  if (o.gone.length > 0) messages.push('前の生成はサーバーに見つかりませんでした。');
  if (o.alreadySucceeded.length > 0) messages.push('取り消す前に完了していました。候補を確認できます。');
  if (o.alreadyFailed.length > 0) messages.push('取り消す前に生成が失敗していました。候補は作られていません。');
  return messages;
}
