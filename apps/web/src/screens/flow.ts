/**
 * U01 screen flow: a pure reducer (no React, no I/O) so every transition can be tested in node.
 * Async mock calls live in the components; they only dispatch the outcome here.
 */
export type Tab = 'trips' | 'new' | 'feed';

export type Screen =
  | { name: 'tripList' }
  | { name: 'condition' }
  | { name: 'progress'; jobId: string; pollAfterMs: number }
  | { name: 'compare'; batchId: string }
  | { name: 'detail'; tripId: string }
  | { name: 'guide'; tripId: string }
  | { name: 'share'; tripId: string }
  | { name: 'feed' };

/** A generation job that was started and not yet dismissed (R28: it keeps running when the user leaves the screen). */
export interface ActiveJob {
  jobId: string;
  pollAfterMs: number;
  /** True once the progress screen saw it succeed. A finished job no longer runs, so it never blocks a new one. */
  succeeded: boolean;
}

/** Why the last generate request was not accepted (kept in the flow so it survives leaving the condition screen). */
export interface SubmitError {
  message: string;
  code?: string;
  retryable?: boolean;
  requestId?: string;
}

export interface FlowState {
  tab: Tab;
  screen: Screen;
  /** Screens to return to with 戻る, oldest first. */
  history: Screen[];
  /**
   * The job the 新規作成 tab resumes. It survives 戻る and tab switches; it is cleared only by an explicit
   * restart, an adopted candidate, or when the job is observed failed/cancelled (or cancelled by the user).
   */
  activeJob: ActiveJob | null;
  /**
   * Unfinished jobs that were displaced by a newer accepted job (not expected: a new submission is blocked while a
   * job is unfinished, and a repeated submission with the same Idempotency-Key returns the same job). They are kept
   * so that no running job becomes unreachable; the condition screen lists them.
   */
  otherJobs: ActiveJob[];
  /** A generate request is in flight. Lives here (not in the component) so leaving and coming back cannot resubmit. */
  submitting: boolean;
  /** The last generate request failed (possibly after the user had left the condition screen). */
  submitError: SubmitError | null;
}

export type FlowAction =
  | { type: 'selectTab'; tab: Tab }
  | { type: 'submitStarted' }
  | { type: 'submitFailed'; error: SubmitError }
  | { type: 'generationStarted'; jobId: string; pollAfterMs: number }
  | { type: 'generationSucceeded'; batchId: string }
  /** The job was observed failed or cancelled (or was cancelled by the user): nothing is left to resume. Does not move the screen. */
  | { type: 'generationEnded'; jobId: string }
  /** Show the progress screen of a known job (続きを確認). */
  | { type: 'viewJob'; jobId: string }
  | { type: 'candidateApplied'; tripId: string }
  | { type: 'openTrip'; tripId: string }
  | { type: 'openGuide'; tripId: string }
  | { type: 'openShare'; tripId: string }
  | { type: 'back' }
  | { type: 'restart' };

export const TAB_ROOT: Record<Tab, Screen> = {
  trips: { name: 'tripList' },
  new: { name: 'condition' },
  feed: { name: 'feed' },
};

export const initialFlow: FlowState = {
  tab: 'trips',
  screen: TAB_ROOT.trips,
  history: [],
  activeJob: null,
  otherJobs: [],
  submitting: false,
  submitError: null,
};

/** Which tab a screen belongs to (the highlighted tab). */
export function tabOf(screen: Screen): Tab {
  switch (screen.name) {
    case 'condition':
    case 'progress':
    case 'compare':
      return 'new';
    case 'feed':
      return 'feed';
    default:
      return 'trips';
  }
}

export function isRoot(state: FlowState): boolean {
  return state.history.length === 0 && state.screen.name === TAB_ROOT[state.tab].name;
}

export function canGoBack(state: FlowState): boolean {
  return state.history.length > 0;
}

/** Every job the flow still knows, the active one first. */
export function knownJobs(state: FlowState): ActiveJob[] {
  return state.activeJob ? [state.activeJob, ...state.otherJobs] : [...state.otherJobs];
}

/** Jobs that may still be running; while one exists a new generation is not allowed (K01: one running job). */
export function unfinishedJobs(state: FlowState): ActiveJob[] {
  return knownJobs(state).filter(j => !j.succeeded);
}

function push(state: FlowState, screen: Screen): FlowState {
  return { ...state, tab: tabOf(screen), screen, history: [...state.history, state.screen] };
}

const progressOf = (job: ActiveJob): Screen => ({ name: 'progress', jobId: job.jobId, pollAfterMs: job.pollAfterMs });

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'selectTab':
      // Selecting a tab returns to that tab's first screen (also pops a deeper screen of the same tab).
      // The exception is 新規作成 with a job still active: it shows that job again (戻る goes to the conditions).
      if (action.tab === 'new' && state.activeJob) {
        return { ...state, tab: 'new', screen: progressOf(state.activeJob), history: [TAB_ROOT.new] };
      }
      return { ...state, tab: action.tab, screen: TAB_ROOT[action.tab], history: [] };

    case 'submitStarted':
      // A second submission while one is in flight, or while a job is unfinished, is refused (same object).
      if (state.submitting || unfinishedJobs(state).length > 0) return state;
      return { ...state, submitting: true, submitError: null };

    case 'submitFailed':
      return { ...state, submitting: false, submitError: action.error };

    case 'generationStarted': {
      const settled: FlowState = { ...state, submitting: false, submitError: null };
      const known = knownJobs(state).find(j => j.jobId === action.jobId);
      if (known) {
        // The same job delivered again (idempotent retry, double delivery): nothing new to record.
        return state.submitting || state.submitError ? settled : state;
      }
      const job: ActiveJob = { jobId: action.jobId, pollAfterMs: action.pollAfterMs, succeeded: false };
      // A different job than the active one never replaces it silently: an unfinished predecessor is kept reachable.
      const others = state.activeJob && !state.activeJob.succeeded ? [...state.otherJobs, state.activeJob] : state.otherJobs;
      const next: FlowState = { ...settled, activeJob: job, otherJobs: others };
      if (state.screen.name === 'condition') return push(next, progressOf(job));
      // The user is watching another job's progress: show the newest one (the earlier job stays in otherJobs).
      if (state.screen.name === 'progress') return { ...next, screen: progressOf(job) };
      // The result arrived after the user left the condition screen: recorded, the screen does not move.
      return next;
    }

    case 'generationEnded': {
      const isActive = state.activeJob?.jobId === action.jobId;
      const inOthers = state.otherJobs.some(j => j.jobId === action.jobId);
      if (!isActive && !inOthers) return state;
      const rest = state.otherJobs.filter(j => j.jobId !== action.jobId);
      if (!isActive) return { ...state, otherJobs: rest };
      // The active job ended: the most recently displaced one, if any, becomes active.
      const promoted = rest[rest.length - 1] ?? null;
      return { ...state, activeJob: promoted, otherJobs: promoted ? rest.slice(0, -1) : rest };
    }

    case 'viewJob': {
      const target = knownJobs(state).find(j => j.jobId === action.jobId);
      if (!target) return state;
      const active = state.activeJob;
      let others = state.otherJobs.filter(j => j.jobId !== action.jobId);
      if (active && active.jobId !== target.jobId && !active.succeeded) others = [...others, active];
      return { ...state, tab: 'new', screen: progressOf(target), history: [TAB_ROOT.new], activeJob: target, otherJobs: others };
    }

    case 'generationSucceeded': {
      // The finished progress screen is replaced, so 戻る from the comparison goes back to the conditions.
      // The job is kept (marked finished) so its result can be reopened from the tab until a candidate is adopted.
      if (state.screen.name !== 'progress') return state;
      const doneId = state.screen.jobId;
      const mark = (j: ActiveJob): ActiveJob => (j.jobId === doneId ? { ...j, succeeded: true } : j);
      return {
        ...state,
        tab: 'new',
        screen: { name: 'compare', batchId: action.batchId },
        activeJob: state.activeJob ? mark(state.activeJob) : null,
        otherJobs: state.otherJobs.map(mark),
      };
    }

    case 'candidateApplied':
      if (state.screen.name !== 'compare') return state;
      // The created trip is opened from the trip list, so 戻る goes to the list. The generation is consumed.
      // Finished jobs are consumed; a job that may still be running stays reachable.
      {
        const running = unfinishedJobs(state);
        return {
          ...state,
          tab: 'trips',
          screen: { name: 'detail', tripId: action.tripId },
          history: [TAB_ROOT.trips],
          activeJob: running[0] ?? null,
          otherJobs: running.slice(1),
        };
      }

    case 'openTrip':
      return push(state, { name: 'detail', tripId: action.tripId });

    case 'openGuide':
      if (state.screen.name !== 'detail') return state;
      return push(state, { name: 'guide', tripId: action.tripId });

    case 'openShare':
      if (state.screen.name !== 'detail') return state;
      return push(state, { name: 'share', tripId: action.tripId });

    case 'back': {
      const previous = state.history[state.history.length - 1];
      if (!previous) return state;
      return { ...state, tab: tabOf(previous), screen: previous, history: state.history.slice(0, -1) };
    }

    case 'restart':
      // Explicit "forget everything about generation" (no screen dispatches it yet).
      return { tab: 'new', screen: TAB_ROOT.new, history: [], activeJob: null, otherJobs: [], submitting: false, submitError: null };
  }
}
