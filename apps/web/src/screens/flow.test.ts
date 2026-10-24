import { describe, expect, it } from 'vitest';
import { TAB_ROOT, canGoBack, flowReducer, initialFlow, isRoot, tabOf, type FlowAction, type FlowState } from './flow.ts';

function run(actions: FlowAction[], from: FlowState = initialFlow): FlowState {
  return actions.reduce(flowReducer, from);
}

describe('flow reducer', () => {
  it('starts on the trip list tab at its root', () => {
    expect(initialFlow.tab).toBe('trips');
    expect(initialFlow.screen).toEqual({ name: 'tripList' });
    expect(isRoot(initialFlow)).toBe(true);
    expect(canGoBack(initialFlow)).toBe(false);
  });

  it('switches tabs to each tab root and clears history', () => {
    const s = run([{ type: 'selectTab', tab: 'new' }]);
    expect(s).toEqual({ tab: 'new', screen: { name: 'condition' }, history: [] });
    expect(run([{ type: 'selectTab', tab: 'feed' }]).screen).toEqual({ name: 'feed' });
    expect(run([{ type: 'selectTab', tab: 'trips' }]).screen).toEqual(TAB_ROOT.trips);
  });

  it('selecting the current tab pops a deeper screen back to the root', () => {
    const deep = run([{ type: 'openTrip', tripId: 't1' }]);
    expect(deep.screen.name).toBe('detail');
    const s = flowReducer(deep, { type: 'selectTab', tab: 'trips' });
    expect(s).toEqual(initialFlow);
  });

  it('goes input -> progress -> compare -> detail -> guide/share and back', () => {
    let s = run([{ type: 'selectTab', tab: 'new' }]);
    s = flowReducer(s, { type: 'generationStarted', jobId: 'j1', pollAfterMs: 700 });
    expect(s.screen).toEqual({ name: 'progress', jobId: 'j1', pollAfterMs: 700 });
    expect(s.tab).toBe('new');

    s = flowReducer(s, { type: 'generationSucceeded', batchId: 'b1' });
    expect(s.screen).toEqual({ name: 'compare', batchId: 'b1' });
    // 戻る from the comparison skips the finished progress screen.
    expect(flowReducer(s, { type: 'back' }).screen).toEqual({ name: 'condition' });

    s = flowReducer(s, { type: 'candidateApplied', tripId: 't9' });
    expect(s.screen).toEqual({ name: 'detail', tripId: 't9' });
    expect(s.tab).toBe('trips');
    expect(s.history).toEqual([{ name: 'tripList' }]);

    const guide = flowReducer(s, { type: 'openGuide', tripId: 't9' });
    expect(guide.screen).toEqual({ name: 'guide', tripId: 't9' });
    expect(tabOf(guide.screen)).toBe('trips');
    expect(flowReducer(guide, { type: 'back' }).screen).toEqual({ name: 'detail', tripId: 't9' });

    const share = flowReducer(s, { type: 'openShare', tripId: 't9' });
    expect(share.screen).toEqual({ name: 'share', tripId: 't9' });
    const backToDetail = flowReducer(share, { type: 'back' });
    expect(backToDetail.screen.name).toBe('detail');
    expect(flowReducer(backToDetail, { type: 'back' }).screen).toEqual({ name: 'tripList' });
  });

  it('opens a trip from the list and returns to the list', () => {
    const s = run([{ type: 'openTrip', tripId: 't1' }]);
    expect(s.screen).toEqual({ name: 'detail', tripId: 't1' });
    expect(canGoBack(s)).toBe(true);
    expect(flowReducer(s, { type: 'back' })).toEqual(initialFlow);
  });

  it('back at a root is a no-op', () => {
    expect(flowReducer(initialFlow, { type: 'back' })).toBe(initialFlow);
  });

  it('failed or cancelled generation: back returns to the conditions', () => {
    const s = run([
      { type: 'selectTab', tab: 'new' },
      { type: 'generationStarted', jobId: 'j1', pollAfterMs: 700 },
      { type: 'back' },
    ]);
    expect(s.screen).toEqual({ name: 'condition' });
    expect(isRoot(s)).toBe(true);
  });

  it('restart goes to a fresh condition screen', () => {
    const s = run([{ type: 'openTrip', tripId: 't1' }, { type: 'restart' }]);
    expect(s).toEqual({ tab: 'new', screen: { name: 'condition' }, history: [] });
  });

  it('ignores actions that do not fit the current screen (late async results)', () => {
    // A job result arriving after the user left the progress screen must not move them.
    const onFeed = run([{ type: 'selectTab', tab: 'feed' }]);
    expect(flowReducer(onFeed, { type: 'generationSucceeded', batchId: 'b1' })).toBe(onFeed);
    expect(flowReducer(onFeed, { type: 'generationStarted', jobId: 'j', pollAfterMs: 1 })).toBe(onFeed);
    expect(flowReducer(onFeed, { type: 'candidateApplied', tripId: 't' })).toBe(onFeed);
    expect(flowReducer(initialFlow, { type: 'openGuide', tripId: 't' })).toBe(initialFlow);
    expect(flowReducer(initialFlow, { type: 'openShare', tripId: 't' })).toBe(initialFlow);
  });

  it('does not mutate the previous state', () => {
    const before = structuredClone(initialFlow);
    flowReducer(initialFlow, { type: 'openTrip', tripId: 't1' });
    expect(initialFlow).toEqual(before);
  });

  it('empty and error states live in the screens, not the flow: the tab roots stay reachable from anywhere', () => {
    const s = run([{ type: 'openTrip', tripId: 'missing' }, { type: 'openGuide', tripId: 'missing' }, { type: 'selectTab', tab: 'new' }]);
    expect(s.screen).toEqual({ name: 'condition' });
    expect(s.history).toEqual([]);
  });
});
