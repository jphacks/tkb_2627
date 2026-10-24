import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { JobStatus, PlanBatch } from '@tkb/contracts';
import { CompareView, ProgressView, SummaryCard, type ProgressViewProps } from './GenerateScreens.tsx';
import { initialPoll, pollReducer, summarizeCandidate } from './model.ts';

const html = (el: ReactElement) => renderRaw(el).replace(/<!-- -->/g, '');
const noop = () => undefined;
const job = (over: Partial<JobStatus>): JobStatus => ({ jobId: 'j', state: 'running', stage: 'generating', batchId: null, error: null, updatedAt: '2026-11-01T00:00:00Z', ...over });
const view = (poll = initialPoll, over: Partial<ProgressViewProps> = {}): string =>
  html(<ProgressView poll={poll} confirming={false} cancelling={false} retrying={false} actionError={null} onAskCancel={noop} onConfirmCancel={noop} onKeep={noop} onRetry={noop} onBack={noop} {...over} />);

describe('ProgressView', () => {
  it('loading, running and paused', () => {
    expect(view()).toContain('状態を確認中');
    const running = pollReducer(initialPoll, { type: 'result', job: job({}) });
    expect(view(running)).toContain('候補の生成');
    expect(view(running)).toContain('生成を取り消す');
    expect(view(pollReducer(running, { type: 'hidden' }))).toContain('一時停止');
  });
  it('cancel asks for confirmation before cancelling', () => {
    const running = pollReducer(initialPoll, { type: 'result', job: job({}) });
    const out = view(running, { confirming: true });
    expect(out).toContain('よろしいですか');
    expect(out).toContain('続ける');
  });
  it('failed job: Japanese message, code, retry button only when retryable', () => {
    const err = (retryable: boolean) => pollReducer(initialPoll, { type: 'result', job: job({ state: 'failed', error: { code: 'CLI_TIMEOUT', message: 'timeout', retryable, requestId: 'r' } }) });
    const out = view(err(true));
    expect(out).toContain('タイムアウト');
    expect(out).toContain('CLI_TIMEOUT');
    expect(out).toContain('同じ条件で再試行');
    expect(view(err(false))).not.toContain('同じ条件で再試行');
  });
  it('cancelled shows the confirmation and a resubmit button', () => {
    const out = view(pollReducer(initialPoll, { type: 'cancelled' }));
    expect(out).toContain('生成を取り消しました');
    expect(out).toContain('もう一度生成');
  });
});

const cand = (over: Partial<PlanBatch['candidates'][number]> = {}): PlanBatch['candidates'][number] => ({
  candidateId: 'c1', title: '案A', days: [], reasons: ['理由1'], warnings: ['注意1'], excludedPlaceIds: ['p9'],
  totalKnownCost: [], hasUnknownCost: true, validationState: 'needs_review', ...over,
});

describe('candidate rendering', () => {
  it('unknown cost is shown as 不明 and never as 0', () => {
    const out = html(<SummaryCard summary={summarizeCandidate(cand(), [])} index={0} busy={false} onAdopt={noop} />);
    expect(out).toContain('既知の費用');
    expect(out).toContain('不明');
    expect(out).toContain('不明あり');
    expect(out).not.toMatch(/[￥¥]\s?0\b/);
    expect(out).toContain('理由1');
    expect(out).toContain('注意1');
    expect(out).toContain('除外された場所');
  });
  it('known totals are shown per currency', () => {
    const out = html(<SummaryCard summary={summarizeCandidate(cand({ hasUnknownCost: false, totalKnownCost: [{ currency: 'JPY', amountMinor: 3000 }, { currency: 'EUR', amountMinor: 1000 }] }), [])} index={0} busy={false} onAdopt={noop} />);
    expect(out).toContain('3,000');
    expect(out).toContain('€');
  });
  it('invalid candidate cannot be adopted', () => {
    const out = html(<SummaryCard summary={summarizeCandidate(cand({ validationState: 'invalid' }), [])} index={0} busy={false} onAdopt={noop} />);
    expect(out).toContain('採用できません');
    expect(out).toContain('disabled');
  });
  it('compare view: expired batch shows the 410 message; applied shows the tripId and map link', () => {
    const expired = html(<CompareView load={{ status: 'done', result: { ok: false, source: 'live', error: { code: 'EXPIRED', message: 'e', retryable: false, requestId: 'r' } } }} busyId={null} applyError={null} applied={null} mapHref={null} onAdopt={noop} onReload={noop} onBack={noop} />);
    expect(expired).toContain('有効期限');
    const batch: PlanBatch = { batchId: 'b', baseTripId: null, baseRevision: null, candidates: [cand()], places: [], createdAt: '2026-11-01T00:00:00Z' };
    const done = html(<CompareView load={{ status: 'done', result: { ok: true, source: 'mock', data: batch } }} busyId={null} applyError={null} applied={{ tripId: 'trip_9', revision: 1, warnings: [], trip: {} as never }} mapHref="#/mock/trips/trip_9/map" onAdopt={noop} onReload={noop} onBack={noop} />);
    expect(done).toContain('trip_9');
    expect(done).toContain('href="#/mock/trips/trip_9/map"');
  });
});
