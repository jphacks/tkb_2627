import { describe, expect, it } from 'vitest';
import type { ApiError, JobStatus } from '@tkb/contracts';
import { kanazawaPlaces } from '@tkb/fixtures';
import { createMockApi } from '../../mocks/index.ts';
import {
  BACKOFF_MS, MAX_CONSECUTIVE_ERRORS, MAX_POLLS, applyErrorMessage, buildApplyRequest, aiReasonMessage, canRetry, createRetryKeys, freshIdempotencyKey, initialPoll, modeChipLabel,
  jobErrorMessage, nextDelayMs, pollReducer, shouldPoll, summarizeCandidate, type PollEvent, type PollState,
} from './model.ts';

const job = (state: JobStatus['state'], stage: JobStatus['stage'] = 'generating', extra: Partial<JobStatus> = {}): JobStatus => ({
  jobId: 'job_1', state, stage, batchId: null, error: null, updatedAt: '2026-11-01T00:00:00Z', ...extra,
});
const apiErr = (code: ApiError['code'], retryable = true): ApiError => ({ code, message: 'x', retryable, requestId: 'r' });
const run = (events: PollEvent[], from: PollState = initialPoll) => events.reduce(pollReducer, from);

describe('polling state machine', () => {
  it('starts polling; first delay honours pollAfterMs', () => {
    expect(shouldPoll(initialPoll)).toBe(true);
    expect(nextDelayMs(initialPoll, 2500)).toBe(2500);
  });

  it('backs off 1s -> 2s -> 5s and caps while nothing changes', () => {
    let s = run([{ type: 'result', job: job('running') }]);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) { delays.push(nextDelayMs(s)); s = pollReducer(s, { type: 'result', job: job('running') }); }
    expect(delays.slice(0, 3)).toEqual([...BACKOFF_MS]);
    expect(delays.slice(3)).toEqual([5000, 5000]);
  });

  it('a changed stage resets the backoff', () => {
    let s = run([{ type: 'result', job: job('running') }, { type: 'result', job: job('running') }, { type: 'result', job: job('running') }, { type: 'result', job: job('running') }]);
    expect(nextDelayMs(s)).toBe(5000);
    s = pollReducer(s, { type: 'result', job: job('running', 'validating') });
    expect(nextDelayMs(s)).toBe(1000);
  });

  it.each([
    ['succeeded', job('succeeded', 'done', { batchId: 'b1' })],
    ['failed', job('failed', 'generating', { error: apiErr('CLI_EXIT') })],
    ['cancelled', job('cancelled', 'queued')],
  ])('terminal state %s stops polling and is final', (_n, j) => {
    const s = pollReducer(initialPoll, { type: 'result', job: j });
    expect(s.status).toBe('terminal');
    expect(shouldPoll(s)).toBe(false);
    expect(pollReducer(s, { type: 'result', job: job('running') })).toBe(s);
    expect(pollReducer(s, { type: 'visible' })).toBe(s);
  });

  it('hidden pauses, visible resumes with fresh backoff; a late result while hidden keeps it paused', () => {
    let s = run([{ type: 'result', job: job('running') }, { type: 'result', job: job('running') }]);
    s = pollReducer(s, { type: 'hidden' });
    expect(s.status).toBe('paused');
    expect(shouldPoll(s)).toBe(false);
    s = pollReducer(s, { type: 'result', job: job('running') });
    expect(s.status).toBe('paused');
    s = pollReducer(s, { type: 'visible' });
    expect(s.status).toBe('polling');
    expect(nextDelayMs(s)).toBe(1000);
  });

  it('a terminal result that arrives while hidden still ends the machine', () => {
    const s = run([{ type: 'hidden' }, { type: 'result', job: job('succeeded', 'done', { batchId: 'b' }) }]);
    expect(s.status).toBe('terminal');
  });

  it('transient errors retry with backoff then give up after the limit; non-retryable gives up at once', () => {
    let s = initialPoll;
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS - 1; i++) s = pollReducer(s, { type: 'error', error: apiErr('UNAVAILABLE') });
    expect(s.status).toBe('polling');
    expect(nextDelayMs(s)).toBeGreaterThanOrEqual(2000);
    s = pollReducer(s, { type: 'error', error: apiErr('UNAVAILABLE') });
    expect(s.status).toBe('gave_up');
    expect(pollReducer(initialPoll, { type: 'error', error: apiErr('NOT_FOUND', false) }).status).toBe('gave_up');
  });

  it('a successful poll clears the error count', () => {
    const s = run([{ type: 'error', error: apiErr('UNAVAILABLE') }, { type: 'result', job: job('running') }]);
    expect(s.errors).toBe(0);
    expect(s.lastError).toBeNull();
  });

  it('never polls unbounded: MAX_POLLS stops an unfinished job', () => {
    let s = initialPoll;
    for (let i = 0; i < MAX_POLLS + 5; i++) s = pollReducer(s, { type: 'result', job: job('running') });
    expect(s.status).toBe('gave_up');
    expect(s.polls).toBe(MAX_POLLS);
  });

  it('cancel confirmation ends polling as cancelled', () => {
    const s = run([{ type: 'result', job: job('running') }, { type: 'cancelled' }]);
    expect(s).toMatchObject({ status: 'terminal', cancelled: true });
    expect(shouldPoll(s)).toBe(false);
  });
});

describe('error messages', () => {
  it.each(['CLI_NOT_AUTHENTICATED', 'CLI_LIMIT', 'CLI_TIMEOUT', 'CLI_EXIT', 'INVALID_OUTPUT', 'WORKER_RESTARTED', 'AI_UNAVAILABLE'] as const)(
    '%s has a Japanese message that is not the server text', code => {
      const m = jobErrorMessage({ code, message: 'server english' });
      expect(m).toMatch(/[぀-ヿ一-鿿]/);
      expect(m).not.toContain('server english');
    });
  it('410 / 409 apply failures are explained', () => {
    expect(applyErrorMessage({ code: 'EXPIRED', message: '' })).toContain('有効期限');
    expect(applyErrorMessage({ code: 'ALREADY_COMMITTED', message: '' })).toContain('すでに採用');
    expect(applyErrorMessage({ code: 'REVISION_CONFLICT', message: '' })).toContain('更新');
  });
  it('retry is offered for retryable errors and WORKER_RESTARTED only', () => {
    expect(canRetry({ retryable: true, code: 'CLI_EXIT' })).toBe(true);
    expect(canRetry({ retryable: false, code: 'WORKER_RESTARTED' })).toBe(true);
    expect(canRetry({ retryable: false, code: 'CLI_NOT_AUTHENTICATED' })).toBe(false);
  });
  it('every retry gets a new, valid idempotency key', () => {
    const a = freshIdempotencyKey();
    const b = freshIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});

describe('candidate summary and apply body', () => {
  it('keeps unknown cost unknown (no 0) and resolves excluded place names', async () => {
    const mock = createMockApi({ scenario: 'budgetUnknown' });
    const acc = await mock.generate({ mode: 'generate', constraints: { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit', budget: null } });
    if (!acc.ok) throw new Error('generate failed');
    let batchId: string | null = null;
    for (let i = 0; i < 20 && !batchId; i++) {
      const j = await mock.getJob(acc.data.jobId);
      if (j.ok) batchId = j.data.batchId;
    }
    const batch = await mock.getPlanBatch(batchId!);
    if (!batch.ok) throw new Error('batch failed');
    const sums = batch.data.candidates.map(c => summarizeCandidate(c, batch.data.places));
    expect(sums.length).toBeGreaterThan(0);
    expect(sums.some(s => s.hasUnknownCost)).toBe(true);
    const withEmpty = summarizeCandidate({ ...batch.data.candidates[0]!, totalKnownCost: [], hasUnknownCost: true }, batch.data.places);
    expect(withEmpty.totals).toEqual([]);
    const ex = summarizeCandidate({ ...batch.data.candidates[0]!, excludedPlaceIds: [kanazawaPlaces[0]!.placeId, 'zz_unknown'] }, [kanazawaPlaces[0]!]);
    expect(ex.excluded).toEqual([{ placeId: kanazawaPlaces[0]!.placeId, name: kanazawaPlaces[0]!.name }, { placeId: 'zz_unknown', name: null }]);
  });

  it('invalid / needs_revalidation candidates are not adoptable', () => {
    const base = { candidateId: 'c', title: 't', days: [], reasons: [], warnings: [], excludedPlaceIds: [], totalKnownCost: [], hasUnknownCost: false };
    expect(summarizeCandidate({ ...base, validationState: 'invalid' }, []).adoptable).toBe(false);
    expect(summarizeCandidate({ ...base, validationState: 'needs_revalidation' }, []).adoptable).toBe(false);
    expect(summarizeCandidate({ ...base, validationState: 'needs_review' }, []).adoptable).toBe(true);
    expect(summarizeCandidate({ ...base, validationState: 'valid' }, []).durationSeconds).toBeNull();
  });

  it('apply request is exactly {batchId, candidateId, tripId:null, expectedRevision:null}', () => {
    expect(buildApplyRequest('b1', 'c1')).toEqual({ batchId: 'b1', candidateId: 'c1', tripId: null, expectedRevision: null });
    expect(Object.keys(buildApplyRequest('b1', 'c1')).sort()).toEqual(['batchId', 'candidateId', 'expectedRevision', 'tripId']);
  });
});

describe('retry keys and mode labels', () => {
  it('reuses the key until done() (network failure then re-press), then issues a new one', () => {
    let n = 0;
    const k = createRetryKeys(() => `r${n++}abcdefgh`);
    const first = k.acquire();
    expect(k.acquire()).toBe(first);
    k.done();
    expect(k.acquire()).not.toBe(first);
  });
  it('labels per dataMode, AI reasons and neutral states', () => {
    expect(modeChipLabel({ status: 'done', dataMode: 'fixture', ai: { available: true, reason: null } })).toContain('実在の情報ではありません');
    expect(modeChipLabel({ status: 'done', dataMode: 'mixed', ai: { available: true, reason: null } })).toBe('場所はfixture、経路は実データ');
    expect(modeChipLabel({ status: 'done', dataMode: 'live', ai: { available: true, reason: null } })).toBe('実データ');
    expect(modeChipLabel({ status: 'loading' })).toBe('接続状態を確認中');
    expect(modeChipLabel({ status: 'error' })).toBe('接続状態を取得できません');
    expect(aiReasonMessage('CLI_NOT_FOUND')).toContain('CLI');
    expect(aiReasonMessage('NEW_CODE')).toContain('未知');
  });
});
