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
import { flowReducer, initialFlow, type FlowAction, type FlowState } from './flow.ts';
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

  return {
    api,
    get flow() {
      return flow;
    },
    dispatch,
    /** ConditionInput.submit */
    async submit(form: ConditionForm) {
      const { request } = validateCondition(form);
      if (!request) return { sent: false as const };
      const result = await api.generate(request);
      if (result.ok) dispatch({ type: 'generationStarted', jobId: result.data.jobId, pollAfterMs: result.data.pollAfterMs });
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
    expect(editHtml).not.toContain('不明');
    for (const name of ['金沢駅', '兼六園', '金沢21世紀美術館']) expect(editHtml).toContain(name);

    const unknownItem = before.days.flatMap(d => d.items).find(i => i.type === 'activity' && i.cost === null);
    if (!unknownItem || unknownItem.type !== 'activity') throw new Error('fixture needs an unknown-cost activity');
    const patched = must(await c.api.patchTrip(tripId, { expectedRevision: 1, operations: [{ op: 'remove', itemId: unknownItem.activityId }] }));
    expect(patched.revision).toBe(2);
    expect(patched.trip.validationState).toBe('needs_revalidation');
    expect(patched.diff.unknownCostItems).toContain(unknownItem.activityId);
    expect(patched.diff.knownCostDelta).toEqual([]);
    expect(patched.diff.knownCostDelta.every(m => m.amountMinor !== 0)).toBe(true);
    const unknownDuration = unknownItem.start === null || unknownItem.end === null;
    if (unknownDuration) expect(patched.diff.durationDeltaSeconds).toBeNull();
    else expect(patched.diff.durationDeltaSeconds).toBe(-Math.round((Date.parse(unknownItem.end?.utc ?? '') - Date.parse(unknownItem.start?.utc ?? '')) / 1000));
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

  it('leaving a running job (tab switch) and cancelling it as the component does leaves it cancelled, saved nothing, and a new run is independent', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const sent = await c.submit(sampleForm);
    if (!sent.sent || !sent.result.ok) throw new Error('submit');
    const jobId = sent.result.data.jobId;
    must(await c.api.getJob(jobId)); // queued
    expect(must(await c.api.getJob(jobId)).state).toBe('running');

    // the user leaves; the flow forgets the job, so the unmount effect must cancel it with the id it holds
    c.dispatch({ type: 'selectTab', tab: 'feed' });
    expect(JSON.stringify(c.flow)).not.toContain(jobId);
    const cancelled = must(await c.api.cancelJob(jobId));
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.batchId).toBeNull();
    expect(must(await c.api.getJob(jobId)).state).toBe('cancelled');
    expect(must(await c.api.listTrips()).items.length).toBe(3);

    const { jobId: next } = await toCompare(c);
    expect(next).not.toBe(jobId);
    expect(must(await c.api.getJob(jobId)).state).toBe('cancelled'); // the old job stays cancelled
  });

  it('a generate result that arrives after the user left the condition screen: the job is cancelled, the flow does not move', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const { request } = validateCondition(sampleForm);
    if (!request) throw new Error('form');
    const pending = c.api.generate(request); // request in flight
    c.dispatch({ type: 'selectTab', tab: 'feed' }); // user leaves
    const accepted = must(await pending);
    // ConditionInput sees it is unmounted and cancels instead of dispatching generationStarted
    const before = c.flow;
    const cancelled = must(await c.api.cancelJob(accepted.jobId));
    expect(cancelled.state).toBe('cancelled');
    expect(c.flow).toBe(before);
    expect(c.flow.screen).toEqual({ name: 'feed' });
    expect(must(await c.api.getJob(accepted.jobId)).state).toBe('cancelled');
    // and if the late result were dispatched anyway the reducer still ignores it
    c.dispatch({ type: 'generationStarted', jobId: accepted.jobId, pollAfterMs: accepted.pollAfterMs });
    expect(c.flow).toBe(before);
  });

  it('error scenario: the job fails visibly, the flow never reaches compare, and a retry starts a new job', async () => {
    const c = createController('error');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const sent = await c.submit(sampleForm);
    if (!sent.sent || !sent.result.ok) throw new Error('submit');
    const statuses = await c.pollToEnd(sent.result.data.jobId);
    const last = statuses[statuses.length - 1] as JobStatus;
    expect(last.state).toBe('failed');
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
  it('double submit: the screen follows the first job; the second job is created but nothing in the flow refers to it (characterization)', async () => {
    const c = createController('normal');
    c.dispatch({ type: 'selectTab', tab: 'new' });
    const [a, b] = await Promise.all([c.submit(sampleForm), c.submit(sampleForm)]);
    if (!a.sent || !a.result.ok || !b.sent || !b.result.ok) throw new Error('both submits should be accepted by the mock');
    expect(a.result.data.jobId).not.toBe(b.result.data.jobId);
    expect(c.flow.screen).toMatchObject({ name: 'progress', jobId: a.result.data.jobId });
    expect(c.flow.history).toHaveLength(1);
    // The second job is still alive and unreferenced: with a real runner this would be a wasted job. The UI
    // prevents it by disabling the submit button while the request is in flight (busy), which is not testable here.
    expect(must(await c.api.getJob(b.result.data.jobId)).state).not.toBe('cancelled');
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
