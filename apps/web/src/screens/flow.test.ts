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
    expect(s).toEqual({ tab: 'new', screen: { name: 'condition' }, history: [], activeJob: null, otherJobs: [], submitting: false, submitError: null });
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
    expect(s).toEqual({ tab: 'new', screen: { name: 'condition' }, history: [], activeJob: null, otherJobs: [], submitting: false, submitError: null });
  });

  it('ignores actions that do not fit the current screen (late async results)', () => {
    // A job result arriving after the user left the progress screen must not move them.
    const onFeed = run([{ type: 'selectTab', tab: 'feed' }]);
    expect(flowReducer(onFeed, { type: 'generationSucceeded', batchId: 'b1' })).toBe(onFeed);
    expect(flowReducer(onFeed, { type: 'candidateApplied', tripId: 't' })).toBe(onFeed);
    expect(flowReducer(onFeed, { type: 'generationEnded', jobId: 'nope' })).toBe(onFeed);
    expect(flowReducer(initialFlow, { type: 'openGuide', tripId: 't' })).toBe(initialFlow);
    expect(flowReducer(initialFlow, { type: 'openShare', tripId: 't' })).toBe(initialFlow);
  });

  describe('background generation (R28): leaving the progress screen does not cancel the job', () => {
    const toProgress = (jobId = 'j1') => run([{ type: 'selectTab', tab: 'new' }, { type: 'generationStarted', jobId, pollAfterMs: 700 }]);

    it('starting a generation records the active job', () => {
      expect(toProgress().activeJob).toEqual({ jobId: 'j1', pollAfterMs: 700, succeeded: false });
    });

    it('戻る keeps the active job; the 新規作成 tab then shows the same job again (戻る from there goes to the conditions)', () => {
      const back = flowReducer(toProgress(), { type: 'back' });
      expect(back.screen).toEqual({ name: 'condition' });
      expect(back.activeJob).toEqual({ jobId: 'j1', pollAfterMs: 700, succeeded: false });
      const resumed = flowReducer(back, { type: 'selectTab', tab: 'new' });
      expect(resumed.screen).toEqual({ name: 'progress', jobId: 'j1', pollAfterMs: 700 });
      expect(resumed.tab).toBe('new');
      expect(flowReducer(resumed, { type: 'back' }).screen).toEqual({ name: 'condition' });
    });

    it('a tab switch keeps the active job and returning to 新規作成 resumes it by jobId', () => {
      const away = flowReducer(toProgress('job_running'), { type: 'selectTab', tab: 'feed' });
      expect(away.screen).toEqual({ name: 'feed' });
      expect(away.activeJob?.jobId).toBe('job_running');
      const trips = flowReducer(away, { type: 'selectTab', tab: 'trips' });
      expect(trips.activeJob?.jobId).toBe('job_running');
      expect(flowReducer(trips, { type: 'selectTab', tab: 'new' }).screen).toMatchObject({ name: 'progress', jobId: 'job_running' });
    });

    it('a succeeded job stays reachable: the tab shows the progress screen again, which offers the comparison', () => {
      const compare = flowReducer(toProgress(), { type: 'generationSucceeded', batchId: 'b1' });
      expect(compare.activeJob?.jobId).toBe('j1');
      const away = flowReducer(compare, { type: 'selectTab', tab: 'feed' });
      expect(flowReducer(away, { type: 'selectTab', tab: 'new' }).screen).toMatchObject({ name: 'progress', jobId: 'j1' });
    });

    it('a generate result that arrives after the user left the condition screen is recorded without moving the user', () => {
      const onFeed = run([{ type: 'selectTab', tab: 'new' }, { type: 'selectTab', tab: 'feed' }]);
      const late = flowReducer(onFeed, { type: 'generationStarted', jobId: 'late', pollAfterMs: 500 });
      expect(late.screen).toEqual({ name: 'feed' });
      expect(late.history).toEqual([]);
      expect(late.activeJob).toEqual({ jobId: 'late', pollAfterMs: 500, succeeded: false });
      expect(flowReducer(late, { type: 'selectTab', tab: 'new' }).screen).toMatchObject({ name: 'progress', jobId: 'late' });
      // the same late result delivered twice changes nothing
      expect(flowReducer(late, { type: 'generationStarted', jobId: 'late', pollAfterMs: 500 })).toBe(late);
    });

    it('a finished job is replaced by a new generation (nothing is running); restart forgets everything', () => {
      const compare = flowReducer(toProgress('old'), { type: 'generationSucceeded', batchId: 'b1' });
      const back = flowReducer(compare, { type: 'back' });
      expect(back.screen).toEqual({ name: 'condition' });
      const next = flowReducer(back, { type: 'generationStarted', jobId: 'new', pollAfterMs: 700 });
      expect(next.screen).toMatchObject({ name: 'progress', jobId: 'new' });
      expect(next.activeJob?.jobId).toBe('new');
      expect(next.otherJobs).toEqual([]);
      expect(flowReducer(next, { type: 'restart' }).activeJob).toBeNull();
    });

    it('a different job accepted while an unfinished one is active never drops it: the newest is shown, the earlier stays reachable', () => {
      const first = toProgress('j1');
      const second = flowReducer(first, { type: 'generationStarted', jobId: 'j2', pollAfterMs: 700 });
      expect(second.screen).toMatchObject({ name: 'progress', jobId: 'j2' });
      expect(second.activeJob?.jobId).toBe('j2');
      expect(second.otherJobs.map(j => j.jobId)).toEqual(['j1']);
      // the earlier one can be shown again, which swaps them
      const viewed = flowReducer(second, { type: 'viewJob', jobId: 'j1' });
      expect(viewed.screen).toMatchObject({ name: 'progress', jobId: 'j1' });
      expect(viewed.otherJobs.map(j => j.jobId)).toEqual(['j2']);
      // when the active one ends, the displaced one is promoted
      const ended = flowReducer(second, { type: 'generationEnded', jobId: 'j2' });
      expect(ended.activeJob?.jobId).toBe('j1');
      expect(ended.otherJobs).toEqual([]);
      // the same job delivered again changes nothing
      expect(flowReducer(second, { type: 'generationStarted', jobId: 'j1', pollAfterMs: 700 })).toBe(second);
      expect(flowReducer(first, { type: 'generationStarted', jobId: 'j1', pollAfterMs: 700 })).toBe(first);
    });

    it('a late different job while the user is elsewhere is recorded next to the active one, not lost', () => {
      const away = flowReducer(toProgress('j1'), { type: 'selectTab', tab: 'feed' });
      const late = flowReducer(away, { type: 'generationStarted', jobId: 'j2', pollAfterMs: 700 });
      expect(late.screen).toEqual({ name: 'feed' });
      expect(late.activeJob?.jobId).toBe('j2');
      expect(late.otherJobs.map(j => j.jobId)).toEqual(['j1']);
    });

    it('viewJob ignores an unknown job id', () => {
      const p = toProgress('j1');
      expect(flowReducer(p, { type: 'viewJob', jobId: 'nope' })).toBe(p);
    });

    it('a resubmit is refused while a request is in flight or a job is unfinished, also after leaving and returning', () => {
      const cond = run([{ type: 'selectTab', tab: 'new' }]);
      const sending = flowReducer(cond, { type: 'submitStarted' });
      expect(sending.submitting).toBe(true);
      // leave and come back: still in flight, a second submit is refused with the same object
      const back = run([{ type: 'selectTab', tab: 'feed' }, { type: 'selectTab', tab: 'new' }], sending);
      expect(back.submitting).toBe(true);
      expect(flowReducer(back, { type: 'submitStarted' })).toBe(back);
      // accepted: the flag clears and the job is recorded (the user is on the conditions, so progress opens)
      const accepted = flowReducer(back, { type: 'generationStarted', jobId: 'j1', pollAfterMs: 700 });
      expect(accepted.submitting).toBe(false);
      expect(accepted.activeJob?.jobId).toBe('j1');
      // an unfinished job refuses a new submission as well
      const conditions = flowReducer(accepted, { type: 'back' });
      expect(flowReducer(conditions, { type: 'submitStarted' })).toBe(conditions);
      // a finished job does not
      const done = flowReducer(flowReducer(accepted, { type: 'generationSucceeded', batchId: 'b1' }), { type: 'back' });
      expect(flowReducer(done, { type: 'submitStarted' }).submitting).toBe(true);
    });

    it('a failed request is kept in the flow (also when the user left meanwhile) until the next submission', () => {
      const sending = run([{ type: 'selectTab', tab: 'new' }, { type: 'submitStarted' }, { type: 'selectTab', tab: 'feed' }]);
      const failed = flowReducer(sending, { type: 'submitFailed', error: { message: '失敗', code: 'UNAVAILABLE' } });
      expect(failed.submitting).toBe(false);
      expect(failed.submitError).toEqual({ message: '失敗', code: 'UNAVAILABLE' });
      expect(failed.screen).toEqual({ name: 'feed' });
      const back = flowReducer(failed, { type: 'selectTab', tab: 'new' });
      expect(back.submitError?.code).toBe('UNAVAILABLE');
      expect(flowReducer(back, { type: 'submitStarted' }).submitError).toBeNull();
    });

    it('failed or cancelled jobs are forgotten (generationEnded) without moving the screen; other job ids are ignored', () => {
      const p = toProgress('j1');
      expect(flowReducer(p, { type: 'generationEnded', jobId: 'other' })).toBe(p);
      const ended = flowReducer(p, { type: 'generationEnded', jobId: 'j1' });
      expect(ended.activeJob).toBeNull();
      expect(ended.screen).toEqual(p.screen);
      expect(flowReducer(flowReducer(ended, { type: 'selectTab', tab: 'feed' }), { type: 'selectTab', tab: 'new' }).screen).toEqual({ name: 'condition' });
    });

    it('adopting a candidate consumes the generation', () => {
      const compare = flowReducer(toProgress(), { type: 'generationSucceeded', batchId: 'b1' });
      const applied = flowReducer(compare, { type: 'candidateApplied', tripId: 't1' });
      expect(applied.activeJob).toBeNull();
      expect(flowReducer(applied, { type: 'selectTab', tab: 'new' }).screen).toEqual({ name: 'condition' });
    });
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
