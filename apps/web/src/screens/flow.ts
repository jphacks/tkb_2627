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

export interface FlowState {
  tab: Tab;
  screen: Screen;
  /** Screens to return to with 戻る, oldest first. */
  history: Screen[];
}

export type FlowAction =
  | { type: 'selectTab'; tab: Tab }
  | { type: 'generationStarted'; jobId: string; pollAfterMs: number }
  | { type: 'generationSucceeded'; batchId: string }
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

export const initialFlow: FlowState = { tab: 'trips', screen: TAB_ROOT.trips, history: [] };

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
  return { tab: tabOf(screen), screen, history: [...state.history, state.screen] };
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'selectTab':
      // Selecting a tab always returns to that tab's first screen (also pops a deeper screen of the same tab).
      return { tab: action.tab, screen: TAB_ROOT[action.tab], history: [] };

    case 'generationStarted':
      // Only the condition screen can start a generation.
      if (state.screen.name !== 'condition') return state;
      return push(state, { name: 'progress', jobId: action.jobId, pollAfterMs: action.pollAfterMs });

    case 'generationSucceeded':
      // The finished progress screen is replaced, so 戻る from the comparison goes back to the conditions.
      if (state.screen.name !== 'progress') return state;
      return { tab: 'new', screen: { name: 'compare', batchId: action.batchId }, history: state.history };

    case 'candidateApplied':
      if (state.screen.name !== 'compare') return state;
      // The created trip is opened from the trip list, so 戻る goes to the list.
      return { tab: 'trips', screen: { name: 'detail', tripId: action.tripId }, history: [TAB_ROOT.trips] };

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
      return { tab: tabOf(previous), screen: previous, history: state.history.slice(0, -1) };
    }

    case 'restart':
      return { tab: 'new', screen: TAB_ROOT.new, history: [] };
  }
}
