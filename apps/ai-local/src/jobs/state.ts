import type { JobStage, JobState } from '@tkb/contracts';

/** Stage order. Stages only move forward. */
export const STAGE_ORDER: readonly JobStage[] = ['queued', 'collecting_context', 'generating', 'validating', 'saving', 'saved', 'done'];
const rank = (s: JobStage) => STAGE_ORDER.indexOf(s);

export interface JobPhase {
  state: JobState;
  stage: JobStage;
}

export const isTerminalState = (s: JobState): boolean => s === 'succeeded' || s === 'failed' || s === 'cancelled';

/** Stage at which a cancel can no longer be honoured (the save may already be committed in the shared DB). */
export const isSavingOrLater = (s: JobStage): boolean => rank(s) >= rank('saving');

const EDGES: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/**
 * Pure state machine. Returns `to` when the move is legal, throws otherwise.
 * - terminal states are immutable
 * - queued -> running -> succeeded|failed|cancelled; queued -> cancelled|failed
 * - running -> running only as a strict stage advance
 * - stages never go backwards; `succeeded` requires stage `done`
 */
export function transition(from: JobPhase, to: JobPhase): JobPhase {
  if (!EDGES[from.state].includes(to.state)) throw new Error(`illegal job transition ${from.state} -> ${to.state}`);
  const a = rank(from.stage);
  const b = rank(to.stage);
  if (b < a) throw new Error(`illegal stage regression ${from.stage} -> ${to.stage}`);
  if (from.state === 'running' && to.state === 'running' && b === a) throw new Error('running -> running must advance the stage');
  if (to.state === 'queued') throw new Error('cannot return to queued');
  if (to.state === 'succeeded' && to.stage !== 'done') throw new Error('succeeded requires stage done');
  if (to.state === 'succeeded' && from.stage === 'queued') throw new Error('succeeded requires a run');
  return { state: to.state, stage: to.stage };
}
