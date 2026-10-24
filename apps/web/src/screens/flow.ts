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
}

export interface FlowState {
  tab: Tab;
  screen: Screen;
  /** Screens to return to with 戻る, oldest first. */
  history: Screen[];
  /**
   * The job the 新規作成 tab resumes. It survives 戻る and tab switches; it is cleared only by an explicit
   * restart, an adopted candidate, or when the job is observed failed/cancelled. A new generation replaces it.
   */
  activeJob: ActiveJob | null;
}

export type FlowAction =
  | { type: 'selectTab'; tab: Tab }
  | { type: 'generationStarted'; jobId: string; pollAfterMs: number }
  | { type: 'generationSucceeded'; batchId: string }
  /** The job was observed failed or cancelled: nothing is left to resume. Does not move the screen. */
  | { type: 'generationEnded'; jobId: string }
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

export const initialFlow: FlowState = { tab: 'trips', screen: TAB_ROOT.trips, history: [], activeJob: null };

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

function push(state: FlowState, screen: Screen): FlowState {
  return { ...state, tab: tabOf(screen), screen, history: [...state.history, state.screen] };
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'selectTab':
      // Selecting a tab returns to that tab's first screen (also pops a deeper screen of the same tab).
      // The exception is 新規作成 with a job still active: it shows that job again (戻る goes to the conditions).
      if (action.tab === 'new' && state.activeJob) {
        const { jobId, pollAfterMs } = state.activeJob;
        return { ...state, tab: 'new', screen: { name: 'progress', jobId, pollAfterMs }, history: [TAB_ROOT.new] };
      }
      return { ...state, tab: action.tab, screen: TAB_ROOT[action.tab], history: [] };

    case 'generationStarted': {
      // A double submit while the progress screen is showing keeps following the first job.
      if (state.screen.name === 'progress') return state;
      if (state.screen.name === 'condition') {
        const next = push(state, { name: 'progress', jobId: action.jobId, pollAfterMs: action.pollAfterMs });
        return { ...next, activeJob: { jobId: action.jobId, pollAfterMs: action.pollAfterMs } };
      }
      // The accepted job arrived after the user left the condition screen: it is recorded (not cancelled, not
      // dropped) and the screen does not move. It replaces any earlier active job.
      if (state.activeJob?.jobId === action.jobId) return state;
      return { ...state, activeJob: { jobId: action.jobId, pollAfterMs: action.pollAfterMs } };
    }

    case 'generationEnded':
      if (state.activeJob?.jobId !== action.jobId) return state;
      return { ...state, activeJob: null };

    case 'generationSucceeded':
      // The finished progress screen is replaced, so 戻る from the comparison goes back to the conditions.
      // The active job is kept so the finished result can be reopened from the tab until a candidate is adopted.
      if (state.screen.name !== 'progress') return state;
      return { ...state, tab: 'new', screen: { name: 'compare', batchId: action.batchId } };

    case 'candidateApplied':
      if (state.screen.name !== 'compare') return state;
      // The created trip is opened from the trip list, so 戻る goes to the list. The generation is consumed.
      return { tab: 'trips', screen: { name: 'detail', tripId: action.tripId }, history: [TAB_ROOT.trips], activeJob: null };

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
      // Explicitly replaces (forgets) the active job.
      return { tab: 'new', screen: TAB_ROOT.new, history: [], activeJob: null };
  }
}
