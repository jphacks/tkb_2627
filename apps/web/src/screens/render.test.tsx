import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlanBatch, Trip } from '@tkb/contracts';
import { TabBar } from '../components/TabBar.tsx';
import { GENERATE_MOCK_WARNING, MOCK_NOTICE, createMockApi, type MockScenario } from '../mocks/index.ts';
import { CandidateCard, CompareView } from './CandidateCompare.tsx';
import { ConditionFormView } from './ConditionInput.tsx';
import { emptyForm, sampleForm } from './condition.ts';
import { ProgressView } from './GenerationProgress.tsx';
import { GuideView } from './Guide.tsx';
import { ConflictNotice, DiffView, EditPanel } from './TripDetailEdit.tsx';
import { FeedView, ShareView } from './Share.tsx';
import { TripListView } from './TripList.tsx';
import { U01App } from './U01App.tsx';

const noop = () => {};
/** React inserts <!-- --> between adjacent text nodes; drop it so text assertions read naturally. */
const renderToString = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
/** Explanatory sentences that mention 0円 on purpose (to say it is NOT zero). */
const withoutDisclaimers = (html: string): string => html.replace(/0円(として扱っ|ではありません|としては)/g, '');
/** A zero that was shown as money: ¥0 / ￥0 / 0円 (not part of a larger number). */
const SHOWN_AS_ZERO = /[¥￥]\s?0(?![\d,.])|(?<![\d,.])0円/;

async function batchFor(scenario: MockScenario): Promise<PlanBatch> {
  const api = createMockApi({ scenario });
  const accepted = await api.generate({ constraints: { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' } });
  if (!accepted.ok) throw new Error('generate');
  for (let i = 0; i < 10; i += 1) {
    const job = await api.getJob(accepted.data.jobId);
    if (job.ok && job.data.state === 'succeeded' && job.data.batchId) {
      const batch = await api.getPlanBatch(job.data.batchId);
      if (!batch.ok) throw new Error('batch');
      return batch.data;
    }
  }
  throw new Error('job did not succeed');
}

async function firstTrip(scenario: MockScenario): Promise<Trip> {
  const api = createMockApi({ scenario });
  const list = await api.listTrips();
  if (!list.ok || !list.data.items[0]) throw new Error('no trip');
  const trip = await api.getTrip(list.data.items[0].tripId);
  if (!trip.ok) throw new Error('trip');
  return trip.data;
}

describe('U01App first render', () => {
  const html = renderToString(<U01App />);

  it('shows the mock banner as a status region with MOCK_NOTICE', () => {
    expect(html).toContain(MOCK_NOTICE);
    expect(html).toMatch(/role="status"[^>]*class="u1-banner"|class="u1-banner"[^>]*role="status"/);
    expect(html).toContain('MOCK');
  });

  it('has the scenario switcher and the three Japanese tabs', () => {
    for (const s of ['normal', 'empty', 'error', 'slow', 'budgetUnknown']) expect(html).toContain(`value="${s}"`);
    for (const label of ['旅程', '新規作成', 'フィード']) expect(html).toContain(label);
    expect(html).toContain('aria-current="page"');
  });

  it('starts loading the trip list (no data yet before effects run)', () => {
    expect(html).toContain('旅程を読み込み中');
  });

  it('TabBar renders real buttons for every tab', () => {
    const tabs = renderToString(<TabBar active="new" onSelect={noop} />);
    expect(tabs.match(/<button/g)).toHaveLength(3);
    expect(tabs).toMatch(/aria-current="page"[^>]*>[^]*新規作成/);
  });
});

describe('trip list states', () => {
  it('shows the empty state text in the empty scenario', async () => {
    const result = await createMockApi({ scenario: 'empty' }).listTrips();
    const html = renderToString(<TripListView state={{ status: 'done', result }} onOpen={noop} onRetry={noop} onCreate={noop} />);
    expect(html).toContain('まだ旅程がありません');
    expect(html).toContain('旅程を新規作成する');
    expect(html).toContain('出典: mock');
  });

  it('shows the error with code, request id and a retry button in the error scenario', async () => {
    const result = await createMockApi({ scenario: 'error' }).listTrips();
    const html = renderToString(<TripListView state={{ status: 'done', result }} onOpen={noop} onRetry={noop} onCreate={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('UNAVAILABLE');
    expect(html).toContain('リクエストID');
    expect(html).toContain('再試行');
  });

  it('lists trips with their validation state in the normal scenario', async () => {
    const result = await createMockApi().listTrips();
    const html = renderToString(<TripListView state={{ status: 'done', result }} onOpen={noop} onRetry={noop} onCreate={noop} />);
    expect(html).toContain('u1-cardbtn');
    expect(html).toMatch(/検証済み|要確認|再検証が必要/);
  });
});

describe('condition form', () => {
  const view = (form: typeof emptyForm, submitted: boolean) =>
    renderToString(<ConditionFormView form={form} onChange={noop} onSubmit={noop} submitted={submitted} busy={false} submitError={null} />);

  it('shows missing required fields clearly before and after a submit attempt', () => {
    const before = view(emptyForm, false);
    expect(before).toContain('未入力：地域');
    expect(before).toContain('未入力：交通手段');
    expect(before).not.toContain('role="alert"');
    const after = view(emptyForm, true);
    expect(after).toContain('role="alert"');
    expect(after).toContain('地域を入力してください');
    expect(after).toContain('aria-invalid="true"');
  });

  it('offers the budget as 不明 (default) or an amount, and a complete sample passes', () => {
    const html = view(sampleForm, true);
    expect(html).toContain('不明');
    expect(html).toContain('入力済み：地域');
    expect(html).not.toContain('role="alert"');
  });
});

describe('generation progress', () => {
  const base = { stage: null, batchId: null, jobError: null, pollError: null, note: null, cancelError: null, cancelling: false, polls: 1, onCancel: noop, onResume: noop, onOpenCandidates: noop, onBackToConditions: noop } as const;

  it('shows each job state visibly; only non-terminal states offer 取消', () => {
    const running = renderToString(<ProgressView {...base} state="running" stage="generating" />);
    expect(running).toContain('生成中');
    expect(running).toContain('取消');
    const queued = renderToString(<ProgressView {...base} state="queued" />);
    expect(queued).toContain('順番待ち');
    const done = renderToString(<ProgressView {...base} state="succeeded" stage="saved" batchId="b1" />);
    expect(done).toContain('完了');
    expect(done).toContain('候補を比較する');
    expect(done).not.toContain('>取消<');
  });

  it('shows failure details and cancellation without pretending success', () => {
    const failed = renderToString(
      <ProgressView {...base} state="failed" stage="validating"
        jobError={{ code: 'INVALID_OUTPUT', message: '生成結果を検証できませんでした。', retryable: true, requestId: 'req_x' }} />,
    );
    expect(failed).toContain('失敗');
    expect(failed).toContain('INVALID_OUTPUT');
    expect(failed).toContain('req_x');
    expect(failed).toContain('条件を直して再試行');
    const cancelled = renderToString(<ProgressView {...base} state="cancelled" />);
    expect(cancelled).toContain('取消済み');
    expect(cancelled).toContain('何も保存されていません');
  });

  it('shows a poll error with a resume button', () => {
    const html = renderToString(
      <ProgressView {...base} state="running" pollError={{ code: 'UNAVAILABLE', message: '接続できません', retryable: true, requestId: 'req_p' }} />,
    );
    expect(html).toContain('状態を取得できませんでした');
    expect(html).toContain('状態確認を再開');
  });
});

describe('candidate comparison', () => {
  it('shows GENERATE_MOCK_WARNING and the validation state on every candidate', async () => {
    const batch = await batchFor('normal');
    const html = renderToString(<CompareView state={{ status: 'done', result: { ok: true, data: batch, source: 'mock', status: 200 } }} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />);
    expect(batch.candidates.length).toBeGreaterThan(0);
    expect(html.split(GENERATE_MOCK_WARNING).length - 1).toBe(Math.min(3, batch.candidates.length));
    expect(html).toContain('この候補を採用');
    expect(html).toContain('出典: mock');
    expect(html).toMatch(/検証済み|要確認/);
  });

  it('never shows an unknown cost as 0', async () => {
    const batch = await batchFor('budgetUnknown');
    const html = renderToString(<CompareView state={{ status: 'done', result: { ok: true, data: batch, source: 'mock', status: 200 } }} busyId={null} applyError={null} onAdopt={noop} onRetry={noop} />);
    expect(withoutDisclaimers(html)).not.toMatch(SHOWN_AS_ZERO);

    const [first] = batch.candidates;
    if (!first) throw new Error('candidate');
    const nothingKnown = renderToString(
      <CandidateCard candidate={{ ...first, totalKnownCost: [], hasUnknownCost: true }} index={0} busy={false} onAdopt={noop} />,
    );
    expect(nothingKnown).toContain('不明');
    expect(nothingKnown).toContain('u1-unknown');
    expect(withoutDisclaimers(nothingKnown)).not.toMatch(SHOWN_AS_ZERO);
  });

  it('does not offer 採用 for candidates the main API would refuse', async () => {
    const batch = await batchFor('normal');
    const [first] = batch.candidates;
    if (!first) throw new Error('candidate');
    const html = renderToString(<CandidateCard candidate={{ ...first, validationState: 'invalid' }} index={0} busy={false} onAdopt={noop} />);
    expect(html).toContain('採用できません');
    expect(html).toContain('disabled');
  });
});

describe('detail, edit, guide, share, feed', () => {
  it('renders the diff with unknown duration as 不明 and unknown-cost items listed, not zero', async () => {
    const trip = await firstTrip('budgetUnknown');
    const firstId = trip.days.flatMap(d => d.items).map(i => (i.type === 'activity' ? i.activityId : i.legId))[0] ?? 'x';
    const html = renderToString(<DiffView trip={trip} diff={{ durationDeltaSeconds: null, knownCostDelta: [], unknownCostItems: [firstId] }} />);
    expect(html).toContain('不明（所要時間が不明の予定を含むため算出できません）');
    expect(html).toContain('0円として扱っていません');
    expect(withoutDisclaimers(html)).not.toMatch(SHOWN_AS_ZERO);
    const known = renderToString(<DiffView trip={trip} diff={{ durationDeltaSeconds: -1800, knownCostDelta: [{ currency: 'JPY', amountMinor: -500 }], unknownCostItems: [] }} />);
    expect(known).toContain('-30分');
  });

  it('renders edit controls with accessible names and a conflict notice with 再読込', async () => {
    const trip = await firstTrip('normal');
    const html = renderToString(<EditPanel trip={trip} saving={false} titleDraft={trip.title} onTitleDraft={noop} onPatch={noop} />);
    expect(html).toContain('タイトルを変更');
    expect(html).toContain('を上へ移動');
    expect(html).toContain('を下へ移動');
    expect(html).toContain('を削除');
    const conflict = renderToString(
      <ConflictNotice error={{ code: 'REVISION_CONFLICT', message: 'x', retryable: false, requestId: 'req_c' }} onReload={noop} />,
    );
    expect(conflict).toContain('再読込');
    expect(conflict).toContain('保存していません');
  });

  it('guide is an entry point only: shows the next item and 現在地は未接続', async () => {
    const trip = await firstTrip('normal');
    const html = renderToString(<GuideView trip={trip} now={new Date('2026-11-01T01:00:00Z')} />);
    expect(html).toContain('現在地は未接続');
    expect(html).toContain('次の予定');
    expect(html).toContain('今日の旅程です');
    expect(html).toContain('位置情報は使っていません');
  });

  it('share says it is a mock and nothing is posted; lists the three scopes', async () => {
    const trip = await firstTrip('normal');
    const html = renderToString(<ShareView trip={trip} />);
    expect(html).toContain('モックです');
    expect(html).toContain('何も投稿・保存されません');
    for (const label of ['非公開', 'グループ', '公開']) expect(html).toContain(label);
    expect(html).toContain('表示されない情報: 予算、出発地・帰着地、私的なメモ');
  });

  it('feed shows posts with the mock source, and its empty state', async () => {
    const result = await createMockApi().getFeed({ scope: 'public' });
    const html = renderToString(<FeedView state={{ status: 'done', result }} onRetry={noop} />);
    expect(html).toContain('出典: mock');
    expect(html).toContain('u1-card');
    const groups = await createMockApi().getFeed({ scope: 'groups' });
    expect(renderToString(<FeedView state={{ status: 'done', result: groups }} onRetry={noop} />)).toContain('公開された旅程はまだありません');
  });
});
