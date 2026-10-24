/**
 * U01 independent tests: end-to-end journeys without React. A tiny controller does what the components do
 * (form -> validateCondition -> mock call -> dispatch the outcome into flowReducer) and the presentational
 * views are rendered with the real results, so the acceptance wording of Issue #9 is exercised as a whole:
 * 条件入力 -> 比較 -> 編集 -> ガイド -> 共有.
 */
import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TERMINAL_JOB_STATES } from '@tkb/contracts';
import type { JobStatus, Trip } from '@tkb/contracts';
import { createMockApi, type MockApi, type MockResult, type MockScenario } from '../mocks/index.ts';
import { CompareView } from './CandidateCompare.tsx';
import { emptyForm, sampleForm, validateCondition, type ConditionForm } from './condition.ts';
import { flowReducer, initialFlow, knownJobs, type FlowAction, type FlowState } from './flow.ts';
import { createSubmissionKeys } from './idempotency.ts';
import { ProgressView } from './GenerationProgress.tsx';
import { GuideView } from './Guide.tsx';
import { ShareView } from './Share.tsx';
import { DiffView, EditPanel } from './TripDetailEdit.tsx';
import { TripListView } from './TripList.tsx';

const noop = () => {};
const renderToString = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const SHOWN_AS_ZERO = /[¥￥]\s?0(?![\d,.])|(?<![\d,.])0円/;
const withoutDisclaimers = (html: string): string => html.replace(/0円(として扱っ|ではありません|としては)/g, '');

function must<T>(result: MockResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.data;
}

/** Mirrors what Shell/ConditionInput/GenerationProgress/CandidateCompare do, minus React. */
function createController(scenario: MockScenario = 'normal', extra: { pollsPerStep?: number } = {}) {
  const api: MockApi = createMockApi({ scenario, pollAfterMs: 700, sleep: async () => {}, ...extra });
  let flow: FlowState = initialFlow;
  const dispatch = (action: FlowAction): FlowState => (flow = flowReducer(flow, action));
  const keys = createSubmissionKeys();
  const generateCalls: { key: string | undefined }[] = [];
  const realGenerate = api.generate.bind(api);
  api.generate = (request, options) => {
    generateCalls.push({ key: options?.idempotencyKey });
    return realGenerate(request, options);
  };

  return {
    api,
    get flow() {
      return flow;
    },
    dispatch,
    keys,
    generateCalls,
    /** ConditionInput.submit: the in-flight state lives in the flow; one Idempotency-Key per submission. */
    async submit(form: ConditionForm) {
      const { request } = validateCondition(form);
      if (!request) return { sent: false as const };
      const before = flow;
      dispatch({ type: 'submitStarted' });
      if (flow === before) return { sent: false as const, blocked: true as const }; // refused: in flight or a job is unfinished
      const result = await api.generate(request, { idempotencyKey: keys.keyFor(request) });
      if (result.ok) {
        keys.release();
        dispatch({ type: 'generationStarted', jobId: result.data.jobId, pollAfterMs: result.data.pollAfterMs });
      } else {
        dispatch({ type: 'submitFailed', error: result.error });
      }
      return { sent: true as const, result };
    },
    /** GenerationProgress effect: poll until a terminal state (no timers; the mock advances per call). */
    async pollToEnd(jobId: string, maxPolls = 40) {
      const seen: JobStatus[] = [];
      for (let i = 0; i < maxPolls; i += 1) {
        const status = must(await api.getJob(jobId));
        seen.push(status);
        if (TERMINAL_JOB_STATES.includes(status.state)) return seen;
      }
      throw new Error('job never reached a terminal state');
    },
    /** CandidateCompare.adopt */
    async adopt(batchId: string, candidateId: string) {
      const result = await api.applyCandidate({ batchId, candidateId, tripId: null, expectedRevision: null });
      if (result.ok) dispatch({ type: 'candidateApplied', tripId: result.data.tripId });
      return result;
    },
  };
}

/** Walk the flow to the compare screen and return the finished batch. */
async function toCompare(c: ReturnType<typeof createController>, form: ConditionForm = sampleForm) {
  c.dispatch({ type: 'selectTab', tab: 'new' });
  const sent = await c.submit(form);
  if (!sent.sent || !sent.result.ok) throw new Error('submit failed');
  const jobId = sent.result.data.jobId;
  const statuses = await c.pollToEnd(jobId);
  const last = statuses[statuses.length - 1] as JobStatus;
  if (last.state !== 'succeeded' || !last.batchId) throw new Error(`job ended as ${last.state}`);
  c.dispatch({ type: 'generationSucceeded', batchId: last.batchId });
  const batch = must(await c.api.getPlanBatch(last.batchId));
  return { jobId, statuses, batch };
}

const STAGE_ORDER = ['queued', 'collecting_context', 'generating', 'validating', 'saving', 'saved', 'done'];

describe('journey: normal scenario, 条件入力 -> 比較 -> 編集 -> ガイド -> 共有', () => {
  it('walks every screen of the acceptance sentence and ends back on the list', async () => {
    const c = createController('normal');

    // 1. 条件入力: an empty form cannot start anything, the sample form can.
    c.dispatch({ type: 'selectTab', tab: 'new' });
    expect((await c.submit(emptyForm)).sent).toBe(false);
    expect(c.flow.screen.name).toBe('condition');

    const { jobId, statuses, batch } = await toCompare(c);
    // 2. progress: stages only move forward and end at saved with a batch id; the screen was progress -> compare.
    const stageIdx = statuses.map(s => STAGE_ORDER.indexOf(s.stage));
    expect(stageIdx).toEqual([...stageIdx].sort((a, b) => a - b));
    expect(statuses.map(s => s.state)).toEqual(['queued', 'running', 'running', 'running', 'succeeded']);
    expect(statuses.slice(0, -1).every(s => s.batchId === null)).toBe(true);
    expect(c.flow.screen).toMatchObject({ name: 'compare', batchId: batch.batchId });
    expect(c.flow.tab).toBe('new');
    const progressHtml = renderToString(
      <ProgressView state="succeeded" stage="saved" batchId={batch.batchId} jobError={null} pollError={null} note={null} cancelError={null}
        cancelling={false} polls={statuses.length} onCancel={noop} onResume={noop} onOpenCandidates={noop} onBackToConditions={noop} />,
    );
    expect(progressHtml).toContain('候補を比較する');
    expect(jobId).toBeTruthy();

    // 3. 比較: up to three candidates, each with a state and no unknown cost shown as 0.
    const compareHtml = renderToString(
      <CompareView state={{ status: 'done', result: { ok: true, data: batch, source: 'mock', status: 200 } }} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />,
    );
    expect(batch.candidates.length).toBe(3);
    expect((compareHtml.match(/この候補を採用/g) ?? []).length).toBe(3);
    expect(withoutDisclaimers(compareHtml)).not.toMatch(SHOWN_AS_ZERO);

    // 4. 採用 (candidate_1 has unknown costs): a new trip, revision 1, and the flow opens the detail screen.
    const candidate = batch.candidates.find(x => x.hasUnknownCost);
    if (!candidate) throw new Error('fixture needs a candidate with unknown cost');
    const applied = await c.adopt(batch.batchId, candidate.candidateId);
    expect(applied.ok && applied.status).toBe(201);
    const tripId = must(applied).tripId;
    expect(c.flow.screen).toEqual({ name: 'detail', tripId });
    expect(c.flow.tab).toBe('trips');
    expect(c.flow.history).toEqual([{ name: 'tripList' }]);

    // 5. 編集: R08 every item resolves to a named place; removing an unknown-cost item shows it in the diff, not as 0.
    const before = must(await c.api.getTrip(tripId));
    expect(before.revision).toBe(1);
    expect(before.warnings.some(w => w.includes('モック'))).toBe(true);
    const placeIds = new Set(before.places.map(p => p.placeId));
    for (const item of before.days.flatMap(d => d.items)) {
      if (item.type === 'activity') {
        if (item.placeId) expect(placeIds.has(item.placeId), `activity ${item.activityId}`).toBe(true);
      } else {
        expect(placeIds.has(item.fromPlaceId), `leg ${item.legId} from`).toBe(true);
        expect(placeIds.has(item.toPlaceId), `leg ${item.legId} to`).toBe(true);
      }
    }
    const editHtml = renderToString(<EditPanel trip={before} saving={false} titleDraft={before.title} onTitleDraft={noop} onPatch={noop} />);
    expect(editHtml).not.toContain('移動: 未取得');
    for (const name of ['金沢駅', '兼六園', '金沢21世紀美術館']) expect(editHtml).toContain(name);

    const unknownItem = before.days.flatMap(d => d.items).find(i => i.type === 'activity' && i.cost === null);
    if (!unknownItem || unknownItem.type !== 'activity') throw new Error('fixture needs an unknown-cost activity');
    const patched = must(await c.api.patchTrip(tripId, { expectedRevision: 1, operations: [{ op: 'remove', itemId: unknownItem.activityId }] }));
    expect(patched.revision).toBe(2);
    expect(patched.trip.validationState).toBe('needs_revalidation');
    expect(patched.diff.unknownCostItems).toContain(unknownItem.activityId);
    expect(patched.diff.knownCostDelta).toEqual([]);
    expect(patched.diff.knownCostDelta.every(m => m.amountMinor !== 0)).toBe(true);
    // Main's duration delta is the change of the elapsed span, which is unknown (null) while any item has no
    // start or end. The Kanazawa fixture has such an item (fx_leg_3 has no arrival), so it is null, never 0.
    expect(patched.diff.durationDeltaSeconds).toBeNull();
    const diffHtml = renderToString(<DiffView trip={patched.trip} before={before} diff={patched.diff} />);
    expect(diffHtml).toContain('0円として扱っていません');
    expect(withoutDisclaimers(diffHtml)).not.toMatch(SHOWN_AS_ZERO);
    // the removed item is named by its title from the pre-patch trip, with a "deleted" mark (as DetailBody wires it)
    expect(diffHtml).toContain(`${unknownItem.title}（削除済み）`);
    expect(diffHtml).not.toContain(unknownItem.activityId);
    expect(diffHtml).toContain('削除済み');

    // a known-cost removal: the delta is a single negative JPY entry, with no 0 entry for the unknown items
    const lunch = patched.trip.days.flatMap(d => d.items).find(i => i.type === 'activity' && i.cost !== null && i.cost.amountMinor > 0);
    if (!lunch || lunch.type !== 'activity' || !lunch.cost) throw new Error('fixture needs a known-cost activity');
    const second = must(await c.api.patchTrip(tripId, { expectedRevision: 2, operations: [{ op: 'remove', itemId: lunch.activityId }] }));
    expect(second.diff.knownCostDelta).toEqual([{ currency: 'JPY', amountMinor: -lunch.cost.amountMinor }]);
    expect(second.diff.unknownCostItems).not.toContain(lunch.activityId);
    expect(second.diff.unknownCostItems.length).toBeGreaterThan(0);

    // 6. ガイド: only reachable from the detail, and shows the next planned item without any location.
    c.dispatch({ type: 'openGuide', tripId });
    expect(c.flow.screen).toEqual({ name: 'guide', tripId });
    const trip = must(await c.api.getTrip(tripId));
    const guideHtml = renderToString(<GuideView trip={trip} now={new Date('2026-11-01T01:00:00Z')} />);
    expect(guideHtml).toContain('次の予定');
    expect(guideHtml).toContain('現在地は未接続');
    c.dispatch({ type: 'back' });
    expect(c.flow.screen).toEqual({ name: 'detail', tripId });

    // 7. 共有: reachable from the detail; only a preview, nothing is posted.
    c.dispatch({ type: 'openShare', tripId });
    expect(c.flow.screen).toEqual({ name: 'share', tripId });
    const shareHtml = renderToString(<ShareView trip={trip} />);
    expect(shareHtml).toContain('何も投稿・保存されません');
    const feedBefore = must(await c.api.getFeed({ scope: 'public' }));
    const feedAfter = must(await c.api.getFeed({ scope: 'public' }));
    expect(feedAfter.items.map(p => p.postId)).toEqual(feedBefore.items.map(p => p.postId));
    expect(feedAfter.items.some(p => p.title === trip.title)).toBe(false);

    // 8. back out: share -> detail -> list, and the list shows the edited trip as needing revalidation (版 3).
    c.dispatch({ type: 'back' });
    c.dispatch({ type: 'back' });
    expect(c.flow).toEqual(initialFlow);
    const list = await c.api.listTrips();
    const listHtml = renderToString(<TripListView state={{ status: 'done', result: list }} onOpen={noop} onRetry={noop} onCreate={noop} />);
    expect(listHtml).toContain('再検証が必要');
    expect(listHtml).toContain('版 3');
  });

  it('a car request leads to car legs without fares, and the unknown fares are never summed as 0', async () => {
    const c = createController('normal');
    const { batch } = await toCompare(c, { ...sampleForm, transportMode: 'car' });
    const legs = batch.candidates.flatMap(x => x.days.flatMap(d => d.items)).filter(i => i.type === 'leg' && i.mode !== 'walk');
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      if (leg.type === 'leg') {
        expect(leg.mode).toBe('car');
        expect(leg.fare).toBeNull();
      }
    }
    const html = renderToString(
      <CompareView state={{ status: 'done', result: { ok: true, data: batch, source: 'mock', status: 200 } }} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />,
    );
    expect(withoutDisclaimers(html)).not.toMatch(SHOWN_AS_ZERO);
  });
});

describe('journey: cancel, failure and retry', () => {
  it('cancel during running: the user returns to the conditions, a late result is ignored, nothing is saved, a new run works', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const sent = await c.submit(sampleForm);
    if (!sent.sent || !sent.result.ok) throw new Error('submit');
    const jobId = sent.result.data.jobId;
    expect(c.flow.screen).toMatchObject({ name: 'progress', jobId });

    const running = must(await c.api.getJob(jobId));
    expect(running.state).toBe('queued');
    const running2 = must(await c.api.getJob(jobId));
    expect(running2.state).toBe('running');

    const cancelled = await c.api.cancelJob(jobId);
    expect(cancelled.ok && cancelled.data.state).toBe('cancelled');
    expect(cancelled.ok && cancelled.status).toBe(202);
    const html = renderToString(
      <ProgressView state="cancelled" stage="generating" batchId={null} jobError={null} pollError={null} note={null} cancelError={null}
        cancelling={false} polls={2} onCancel={noop} onResume={noop} onOpenCandidates={noop} onBackToConditions={noop} />,
    );
    expect(html).toContain('何も保存されていません');
    expect(html).not.toContain('>取消<');
    expect(must(await c.api.getJob(jobId)).state).toBe('cancelled');
    c.dispatch({ type: 'generationEnded', jobId }); // GenerationProgress.onSettled reports the cancelled job
    const tripsBefore = must(await c.api.listTrips()).items.length;

    // 戻る goes to the conditions; a stale generationSucceeded must not move the user
    c.dispatch({ type: 'back' });
    expect(c.flow.screen).toEqual({ name: 'condition' });
    const stale = c.flow;
    c.dispatch({ type: 'generationSucceeded', batchId: 'mock_batch_late' });
    expect(c.flow).toBe(stale);
    expect(must(await c.api.listTrips()).items.length).toBe(tripsBefore);

    // run again from the same screen: a new job, which succeeds
    const { jobId: second } = await toCompare(c);
    expect(second).not.toBe(jobId);
    expect(c.flow.screen.name).toBe('compare');
  });

  it('leaving a running job (tab switch) does not cancel it: the flow keeps it, the tab resumes it by jobId, and it finishes into the comparison', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const sent = await c.submit(sampleForm);
    if (!sent.sent || !sent.result.ok) throw new Error('submit');
    const jobId = sent.result.data.jobId;
    must(await c.api.getJob(jobId)); // queued
    expect(must(await c.api.getJob(jobId)).state).toBe('running');

    // the user leaves: nothing calls cancelJob, and the flow still knows the job
    c.dispatch({ type: 'selectTab', tab: 'feed' });
    expect(c.flow.activeJob).toEqual({ jobId, pollAfterMs: sent.result.data.pollAfterMs, succeeded: false });
    expect(must(await c.api.getJob(jobId)).state).toBe('running');
    c.dispatch({ type: 'selectTab', tab: 'trips' });
    expect(c.flow.activeJob?.jobId).toBe(jobId);

    // coming back to 新規作成 shows the progress screen of the same job and polling continues from there
    c.dispatch({ type: 'selectTab', tab: 'new' });
    expect(c.flow.screen).toMatchObject({ name: 'progress', jobId });
    const statuses = await c.pollToEnd(jobId);
    const last = statuses[statuses.length - 1] as JobStatus;
    expect(last.state).toBe('succeeded');
    if (!last.batchId) throw new Error('batch id');
    c.dispatch({ type: 'generationSucceeded', batchId: last.batchId });
    expect(c.flow.screen).toMatchObject({ name: 'compare', batchId: last.batchId });
    expect(must(await c.api.listTrips()).items.length).toBe(3); // nothing was saved by the generation itself
  });

  it('a job that finished while the user was away is shown as a result on return, and stays reachable until a candidate is adopted', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const sent = await c.submit(sampleForm);
    if (!sent.sent || !sent.result.ok) throw new Error('submit');
    const jobId = sent.result.data.jobId;
    c.dispatch({ type: 'selectTab', tab: 'feed' });
    const statuses = await c.pollToEnd(jobId); // finishes in the background
    expect((statuses[statuses.length - 1] as JobStatus).state).toBe('succeeded');

    c.dispatch({ type: 'selectTab', tab: 'new' });
    expect(c.flow.screen).toMatchObject({ name: 'progress', jobId });
    const again = must(await c.api.getJob(jobId)); // the resumed screen's first poll
    expect(again.state).toBe('succeeded');
    const html = renderToString(
      <ProgressView state={again.state} stage={again.stage} batchId={again.batchId} jobError={null} pollError={null} note={null} cancelError={null}
        cancelling={false} polls={1} onCancel={noop} onResume={noop} onOpenCandidates={noop} onBackToConditions={noop} />,
    );
    expect(html).toContain('候補を比較する');
    expect(html).not.toContain('生成を取り消します');
  });

  it('only the 取消 button cancels: the cancelled job is forgotten by the flow once the progress screen reports it', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const sent = await c.submit(sampleForm);
    if (!sent.sent || !sent.result.ok) throw new Error('submit');
    const jobId = sent.result.data.jobId;
    const cancelled = must(await c.api.cancelJob(jobId));
    expect(cancelled.state).toBe('cancelled');
    c.dispatch({ type: 'generationEnded', jobId }); // GenerationProgress.onSettled
    expect(c.flow.activeJob).toBeNull();
    expect(c.flow.screen).toMatchObject({ name: 'progress', jobId }); // the "取り消しました" message stays visible
    c.dispatch({ type: 'selectTab', tab: 'feed' });
    c.dispatch({ type: 'selectTab', tab: 'new' });
    expect(c.flow.screen).toEqual({ name: 'condition' });
    expect(must(await c.api.getJob(jobId)).state).toBe('cancelled');
  });

  it('a generate result that arrives after the user left the condition screen is recorded as the active job, not cancelled or dropped', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const { request } = validateCondition(sampleForm);
    if (!request) throw new Error('form');
    const pending = c.api.generate(request); // request in flight
    c.dispatch({ type: 'selectTab', tab: 'feed' }); // user leaves
    const accepted = must(await pending);
    // ConditionInput always hands the accepted job to the flow, even after unmount
    c.dispatch({ type: 'generationStarted', jobId: accepted.jobId, pollAfterMs: accepted.pollAfterMs });
    expect(c.flow.screen).toEqual({ name: 'feed' }); // the user is not moved
    expect(c.flow.activeJob).toEqual({ jobId: accepted.jobId, pollAfterMs: accepted.pollAfterMs, succeeded: false });
    expect(must(await c.api.getJob(accepted.jobId)).state).not.toBe('cancelled');
    // and it is found again from the tab
    c.dispatch({ type: 'selectTab', tab: 'new' });
    expect(c.flow.screen).toMatchObject({ name: 'progress', jobId: accepted.jobId });
  });

  it('error scenario: the job fails visibly, the flow never reaches compare, and a retry starts a new job', async () => {
    const c = createController('error');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const sent = await c.submit(sampleForm);
    if (!sent.sent || !sent.result.ok) throw new Error('submit');
    const statuses = await c.pollToEnd(sent.result.data.jobId);
    const last = statuses[statuses.length - 1] as JobStatus;
    expect(last.state).toBe('failed');
    c.dispatch({ type: 'generationEnded', jobId: sent.result.data.jobId }); // GenerationProgress.onSettled reports the failed job
    expect(last.batchId).toBeNull();
    expect(last.error?.code).toBe('INVALID_OUTPUT');
    expect(last.error?.retryable).toBe(true);

    const html = renderToString(
      <ProgressView state={last.state} stage={last.stage} batchId={last.batchId} jobError={last.error} pollError={null} note={null} cancelError={null}
        cancelling={false} polls={statuses.length} onCancel={noop} onResume={noop} onOpenCandidates={noop} onBackToConditions={noop} />,
    );
    expect(html).toContain('生成に失敗しました');
    expect(html).toContain('INVALID_OUTPUT');
    expect(html).toContain('条件を直して再試行');
    expect(html).not.toContain('候補を比較する');
    expect(html).not.toContain('>取消<');

    // a stray success event cannot happen from the UI, and the reducer would ignore it only off the progress screen;
    // the user path is: 戻る -> conditions -> submit again.
    c.dispatch({ type: 'back' });
    expect(c.flow.screen).toEqual({ name: 'condition' });
    const retry = await c.submit(sampleForm);
    if (!retry.sent || !retry.result.ok) throw new Error('retry');
    expect(retry.result.data.jobId).not.toBe(sent.result.data.jobId);
    expect(c.flow.screen).toMatchObject({ name: 'progress', jobId: retry.result.data.jobId });

    // reads in this scenario fail as UNAVAILABLE with distinct request ids, rendered with a retry button
    const list1 = await c.api.listTrips();
    const list2 = await c.api.listTrips();
    if (list1.ok || list2.ok) throw new Error('error scenario must fail');
    expect(list1.error.code).toBe('UNAVAILABLE');
    expect(list1.error.requestId).not.toBe(list2.error.requestId);
    const listHtml = renderToString(<TripListView state={{ status: 'done', result: list1 }} onOpen={noop} onRetry={noop} onCreate={noop} />);
    expect(listHtml).toContain(list1.error.requestId);
    expect(listHtml).toContain('再試行');
  });

  it('slow scenario: more polls are needed but the sequence and the outcome are the same as normal', async () => {
    const slow = createController('slow');
    const { statuses, batch } = await toCompare(slow);
    expect(statuses.length).toBe(13); // 5 steps x 3 polls, succeeded on the 13th poll
    const stageIdx = statuses.map(s => STAGE_ORDER.indexOf(s.stage));
    expect(stageIdx).toEqual([...stageIdx].sort((a, b) => a - b));
    expect(batch.candidates.length).toBe(3);
  });
});

describe('journey: empty scenario', () => {
  it('empty list -> new -> generate -> adopt -> the list now has the trip', async () => {
    const c = createController('empty');
    const empty = await c.api.listTrips();
    const emptyHtml = renderToString(<TripListView state={{ status: 'done', result: empty }} onOpen={noop} onRetry={noop} onCreate={noop} />);
    expect(emptyHtml).toContain('まだ旅程がありません');
    expect(emptyHtml).toContain('旅程を新規作成する');

    // the empty-state button dispatches selectTab(new)
    c.dispatch({ type: 'selectTab', tab: 'new' });
    expect(c.flow.screen).toEqual({ name: 'condition' });
    const { batch } = await toCompare(c);
    const first = batch.candidates[0];
    if (!first) throw new Error('candidate');
    const applied = await c.adopt(batch.batchId, first.candidateId);
    const tripId = must(applied).tripId;
    expect(c.flow.screen).toEqual({ name: 'detail', tripId });

    const list = await c.api.listTrips();
    expect(must(list).items.map(t => t.tripId)).toEqual([tripId]);
    expect(must(await c.api.getFeed({ scope: 'public' })).items).toEqual([]);
    c.dispatch({ type: 'back' });
    expect(c.flow).toEqual(initialFlow);
  });

  it('opening a trip that does not exist is a NOT_FOUND screen state, not a crash, and the tab roots stay reachable', async () => {
    const c = createController('empty');
    c.dispatch({ type: 'openTrip', tripId: 'ghost' });
    const r = await c.api.getTrip('ghost');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('NOT_FOUND');
    expect(!r.ok && r.status).toBe(404);
    c.dispatch({ type: 'back' });
    expect(c.flow).toEqual(initialFlow);
  });
});

describe('journey: concurrency of the user and the network', () => {
  it('double submit: the second submission is refused while the first is in flight, so only one job exists', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const [a, b] = await Promise.all([c.submit(sampleForm), c.submit(sampleForm)]);
    if (!a.sent || !a.result.ok) throw new Error('the first submit should be accepted');
    expect(b.sent).toBe(false);
    expect(c.generateCalls).toHaveLength(1);
    expect(c.flow.screen).toMatchObject({ name: 'progress', jobId: a.result.data.jobId });
    expect(knownJobs(c.flow).map(j => j.jobId)).toEqual([a.result.data.jobId]);
  });

  it('leave while generate is in flight, come back and submit again: no second generate call, one job, reachable', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const first = c.submit(sampleForm); // request in flight
    c.dispatch({ type: 'selectTab', tab: 'feed' }); // the user leaves ...
    c.dispatch({ type: 'selectTab', tab: 'new' }); // ... comes back to the conditions ...
    expect(c.flow.submitting).toBe(true); // the in-flight state survived the tab switch
    const second = await c.submit(sampleForm); // ... and presses the button again
    expect(second.sent).toBe(false);
    const done = await first;
    if (!done.sent || !done.result.ok) throw new Error('first submit');
    expect(c.generateCalls).toHaveLength(1);
    expect(knownJobs(c.flow).map(j => j.jobId)).toEqual([done.result.data.jobId]);
    expect(c.flow.submitting).toBe(false);
    // with the job running, a further submission is refused until it is finished or explicitly cancelled
    c.dispatch({ type: 'selectTab', tab: 'new' });
    c.dispatch({ type: 'back' });
    expect((await c.submit(sampleForm)).sent).toBe(false);
    expect(c.generateCalls).toHaveLength(1);
    const cancelled = must(await c.api.cancelJob(done.result.data.jobId));
    expect(cancelled.state).toBe('cancelled');
    c.dispatch({ type: 'generationEnded', jobId: done.result.data.jobId }); // 取り消して新しく作る
    const third = await c.submit(sampleForm);
    expect(third.sent).toBe(true);
    expect(c.generateCalls).toHaveLength(2);
  });

  it('a retry of the same submission reuses the Idempotency-Key and gets the same job; a new submission gets a new key', async () => {
    const c = createController('normal');
    const { request } = validateCondition(sampleForm);
    if (!request) throw new Error('form');
    const k1 = c.keys.keyFor(request);
    expect(k1).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(c.keys.keyFor(request)).toBe(k1); // same body: same key
    const a = must(await c.api.generate(request, { idempotencyKey: k1 }));
    const retry = must(await c.api.generate(request, { idempotencyKey: c.keys.keyFor(request) }));
    expect(retry.jobId).toBe(a.jobId); // the server returns the same job
    c.keys.release(); // accepted
    expect(c.keys.keyFor(request)).not.toBe(k1); // the next submission has a new key
    const changed = { ...request, constraints: { ...request.constraints, area: '別の地域' } };
    expect(c.keys.keyFor(changed)).not.toBe(k1);
  });

  it('a failed submission keeps its key for the retry and shows the error in the flow even after the user left', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const { request } = validateCondition(sampleForm);
    if (!request) throw new Error('form');
    const keyBefore = c.keys.keyFor(request);
    c.dispatch({ type: 'submitStarted' });
    c.dispatch({ type: 'selectTab', tab: 'feed' });
    c.dispatch({ type: 'submitFailed', error: { message: '一時的に利用できません', code: 'UNAVAILABLE', retryable: true } });
    expect(c.flow.submitError?.code).toBe('UNAVAILABLE');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    expect(c.flow.screen).toEqual({ name: 'condition' });
    expect(c.flow.submitError?.message).toBe('一時的に利用できません');
    expect(c.keys.keyFor(request)).toBe(keyBefore); // retry reuses the key
  });

  it('a late different job is not lost: it is recorded next to the running one and both stay reachable', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const first = await c.submit(sampleForm);
    if (!first.sent || !first.result.ok) throw new Error('first');
    c.dispatch({ type: 'selectTab', tab: 'feed' });
    const { request } = validateCondition(sampleForm);
    if (!request) throw new Error('form');
    const other = must(await c.api.generate(request)); // a request that was sent without the guard (e.g. another tab)
    c.dispatch({ type: 'generationStarted', jobId: other.jobId, pollAfterMs: other.pollAfterMs });
    const ids = knownJobs(c.flow).map(j => j.jobId);
    expect(ids).toContain(first.result.data.jobId);
    expect(ids).toContain(other.jobId);
    expect(c.flow.screen).toEqual({ name: 'feed' });
  });

  it('an adopt result that arrives after the user switched tab is ignored by the flow, and the trip is not lost', async () => {
    const c = createController('normal');
    const { batch } = await toCompare(c);
    const first = batch.candidates[0];
    if (!first) throw new Error('candidate');
    const pending = c.adopt(batch.batchId, first.candidateId); // request in flight
    c.dispatch({ type: 'selectTab', tab: 'feed' }); // user leaves
    const result = await pending; // result arrives later and dispatches candidateApplied
    expect(result.ok).toBe(true);
    expect(c.flow.screen).toEqual({ name: 'feed' });
    c.dispatch({ type: 'selectTab', tab: 'trips' });
    const list = must(await c.api.listTrips());
    expect(list.items.some(t => t.tripId === must(result).tripId)).toBe(true);
  });

  it('a stale revision during edit is a conflict and the saved trip is the other writer\'s version', async () => {
    const c = createController('normal');
    const { batch } = await toCompare(c);
    const first = batch.candidates[0];
    if (!first) throw new Error('candidate');
    const tripId = must(await c.adopt(batch.batchId, first.candidateId)).tripId;
    // the other device renames first
    must(await c.api.patchTrip(tripId, { expectedRevision: 1, operations: [{ op: 'set_title', title: '別端末の名前' }] }));
    // this screen still holds revision 1
    const mine = await c.api.patchTrip(tripId, { expectedRevision: 1, operations: [{ op: 'set_title', title: '自分の名前' }] });
    expect(mine.ok).toBe(false);
    if (mine.ok) return;
    expect(mine.error.code).toBe('REVISION_CONFLICT');
    expect(mine.status).toBe(409);
    expect(mine.error.retryable).toBe(false);
    const now: Trip = must(await c.api.getTrip(tripId));
    expect(now.title).toBe('別端末の名前');
    expect(now.revision).toBe(2);
  });
});
