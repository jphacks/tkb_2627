/**
 * U05 pure logic: polling state machine (K02), error-code messages, candidate summaries (K07), apply request (K08).
 * No React, no network: everything here is unit-tested.
 */
import { ApplyCandidateRequest, TERMINAL_JOB_STATES } from '@tkb/contracts';
import type { ApiError, JobStatus, Money, PlanBatch, PlanCandidate, ValidationState } from '@tkb/contracts';

/** Backoff while the job state/stage does not change: 1s -> 2s -> 5s (cap). A changed stage resets it. */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000];
/** Hard bounds: polling never runs unbounded. 120 polls at <=5s is about 10 minutes. */
export const MAX_POLLS = 120;
export const MAX_CONSECUTIVE_ERRORS = 3;

export type PollStatus = 'polling' | 'paused' | 'terminal' | 'gave_up';

export interface PollState {
  status: PollStatus;
  job: JobStatus | null;
  /** Polls without a visible change (drives backoff). */
  unchanged: number;
  /** Total polls made (drives MAX_POLLS). */
  polls: number;
  errors: number;
  /** Bumped after each event so an effect can reschedule. */
  epoch: number;
  /** True when the user cancelled and the server confirmed. */
  cancelled: boolean;
  lastError: ApiError | null;
}

export const initialPoll: PollState = {
  status: 'polling', job: null, unchanged: 0, polls: 0, errors: 0, epoch: 0, cancelled: false, lastError: null,
};

export type PollEvent =
  | { type: 'result'; job: JobStatus }
  | { type: 'error'; error: ApiError }
  | { type: 'hidden' }
  | { type: 'visible' }
  | { type: 'cancelled' };

const isTerminal = (job: JobStatus) => TERMINAL_JOB_STATES.includes(job.state);

export function pollReducer(s: PollState, e: PollEvent): PollState {
  if (s.status === 'terminal' || s.status === 'gave_up') return s; // terminal states are final
  switch (e.type) {
    case 'hidden':
      return s.status === 'polling' ? { ...s, status: 'paused', epoch: s.epoch + 1 } : s;
    case 'visible':
      // Resume with a fresh backoff so the screen catches up quickly.
      return s.status === 'paused' ? { ...s, status: 'polling', unchanged: 0, epoch: s.epoch + 1 } : s;
    case 'cancelled':
      return { ...s, status: 'terminal', cancelled: true, epoch: s.epoch + 1 };
    case 'error': {
      const errors = s.errors + 1;
      const polls = s.polls + 1;
      const giveUp = errors >= MAX_CONSECUTIVE_ERRORS || polls >= MAX_POLLS || !e.error.retryable;
      const status: PollStatus = s.status === 'paused' ? 'paused' : giveUp ? 'gave_up' : 'polling';
      return { ...s, errors, polls, lastError: e.error, status, unchanged: s.unchanged + 1, epoch: s.epoch + 1 };
    }
    case 'result': {
      const polls = s.polls + 1;
      const changed = !s.job || s.job.state !== e.job.state || s.job.stage !== e.job.stage;
      const base = { ...s, job: e.job, polls, errors: 0, lastError: null, unchanged: changed ? 0 : s.unchanged + 1, epoch: s.epoch + 1 };
      if (isTerminal(e.job)) return { ...base, status: 'terminal' };
      if (s.status === 'paused') return base; // late result while hidden: keep paused
      return polls >= MAX_POLLS ? { ...base, status: 'gave_up' } : base;
    }
  }
}

/** Delay before the next poll. The first poll honours the server's pollAfterMs (K01). */
export function nextDelayMs(s: PollState, pollAfterMs = 2000): number {
  if (s.errors > 0) return BACKOFF_MS[Math.min(s.errors, BACKOFF_MS.length - 1)] as number;
  if (s.polls === 0) return pollAfterMs;
  return BACKOFF_MS[Math.min(s.unchanged, BACKOFF_MS.length - 1)] as number;
}

export const shouldPoll = (s: PollState): boolean => s.status === 'polling';

/** Japanese message per job error code (JobStatus.error.code). The server's English text is not the main text. */
export function jobErrorMessage(error: Pick<ApiError, 'code' | 'message'>): string {
  switch (error.code) {
    case 'CLI_NOT_AUTHENTICATED': return 'Claude Code にログインしていません。本人用アプリでログインしてから再試行してください。';
    case 'CLI_LIMIT': return 'Claude Code の利用上限に達しました。時間をおいてから再試行してください。';
    case 'CLI_TIMEOUT': return 'Claude Code の応答がタイムアウトしました。再試行してください。';
    case 'CLI_EXIT': return 'Claude Code が異常終了しました。再試行してください。';
    case 'INVALID_OUTPUT': return '生成結果が決められた形式と一致せず、採用できませんでした。再試行してください。';
    case 'WORKER_RESTARTED': return '生成の途中で本人用アプリが再起動しました。もう一度生成してください。';
    case 'AI_UNAVAILABLE': return 'AI生成は現在利用できません。';
    case 'QUEUE_FULL': return '生成の待ち行列がいっぱいです。しばらくしてから再試行してください。';
    case 'RATE_LIMITED':
    case 'PROVIDER_RATE_LIMIT': return '利用回数の上限に達しました。しばらくしてから再試行してください。';
    case 'PROVIDER_UNAVAILABLE':
    case 'UNAVAILABLE': return '情報源に接続できません。';
    case 'NOT_FOUND': return '生成ジョブが見つかりません（本人用アプリが再起動した可能性があります）。';
    case 'UNAUTHENTICATED': return 'ログインが必要です。';
    case 'FORBIDDEN': return '操作が拒否されました。再読み込みしてください。';
    case 'CANCELLED': return '生成は取り消されました。';
    default: return `生成に失敗しました（${error.code}）。`;
  }
}

/** Message for apply (K08) / batch read (K07) failures. 409/410 get specific guidance. */
export function applyErrorMessage(error: Pick<ApiError, 'code' | 'message'>): string {
  switch (error.code) {
    case 'EXPIRED': return 'この候補の有効期限が切れました。条件入力からもう一度生成してください。';
    case 'ALREADY_COMMITTED': return 'この候補はすでに採用されています。';
    case 'REVISION_CONFLICT': return '旅程が他の操作で更新されました。候補を読み込み直してください。';
    case 'CONSTRAINT_UNSATISFIED': return 'この候補は検証が完了していないため採用できません。';
    case 'NOT_FOUND': return '候補が見つかりません。期限切れの可能性があります。';
    default: return jobErrorMessage(error);
  }
}

/** Whether a failed job offers the retry button (the user presses it; never automatic). */
export const canRetry = (error: { retryable: boolean; code: string }): boolean => error.retryable || error.code === 'WORKER_RESTARTED';

/** Every attempt gets its own Idempotency-Key (the same key with the same input would return the old job). */
export function freshIdempotencyKey(random: () => string = () => crypto.randomUUID()): string {
  return `u05_${random().replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 128);
}

/**
 * One Idempotency-Key per retry attempt: acquire() returns the same key until done() is called
 * (a job id was obtained), so a lost response followed by another press never creates a second job.
 */
export function createRetryKeys(random?: () => string): { acquire: () => string; done: () => void } {
  let current: string | null = null;
  return {
    acquire: () => (current ??= freshIdempotencyKey(random)),
    done: () => { current = null; },
  };
}

export type ModeCapState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'done'; dataMode: 'fixture' | 'mixed' | 'live'; ai: { available: boolean; reason: string | null } };

export const DATA_MODE_LABEL: Record<'fixture' | 'mixed' | 'live', string> = {
  fixture: 'fixtureデータ（実在の情報ではありません）',
  mixed: '場所はfixture、経路は実データ',
  live: '実データ',
};

const AI_REASON_JA: Record<string, string> = {
  SHARED_ENTRY_NO_PERSONAL_CLAUDE: '共有入口からは生成できません（本人用アプリから操作してください）。',
  CLAUDE_EXECUTION_DISABLED: '本人用アプリでClaude実行が無効になっています。',
  CLI_NOT_FOUND: 'Claude Code CLI が見つかりません。',
  CLI_NOT_AUTHENTICATED: 'Claude Code CLI にログインしていません。',
  TERMS_NOT_CONFIRMED: '利用条件の確認が済んでいません。',
};
export const aiReasonMessage = (reason: string | null): string =>
  reason === null ? 'AI生成は現在利用できません（理由は不明です）。' : (AI_REASON_JA[reason] ?? 'AI生成は現在利用できません（未知の理由です）。');

/** Short mode label for the chip on progress/compare. Never claims real data until capabilities say so. */
export function modeChipLabel(s: ModeCapState): string {
  if (s.status === 'loading') return '接続状態を確認中';
  if (s.status === 'error') return '接続状態を取得できません';
  return DATA_MODE_LABEL[s.dataMode];
}

/** NOT adoptable states: the main API refuses them with 422. */
export const NOT_ADOPTABLE: readonly ValidationState[] = ['invalid', 'needs_revalidation'];

export interface CandidateSummary {
  candidateId: string;
  title: string;
  validationState: ValidationState;
  reasons: string[];
  warnings: string[];
  excluded: { placeId: string; name: string | null }[];
  /** Known totals per currency. Empty means nothing known (shown as 不明, never 0). */
  totals: Money[];
  hasUnknownCost: boolean;
  days: number;
  activityCount: number;
  /** Sum of known leg durations; null when no leg has a known duration. */
  durationSeconds: number | null;
  /** True when some legs have no known duration. */
  durationPartial: boolean;
  adoptable: boolean;
}

export function summarizeCandidate(c: PlanCandidate, places: PlanBatch['places']): CandidateSummary {
  const names = new Map(places.map(p => [p.placeId, p.name]));
  let activityCount = 0;
  let known = 0;
  let knownLegs = 0;
  let unknownLegs = 0;
  for (const d of c.days) {
    for (const it of d.items) {
      if (it.type === 'activity') { activityCount += 1; continue; }
      if (it.durationSeconds === null) unknownLegs += 1;
      else { known += it.durationSeconds; knownLegs += 1; }
    }
  }
  return {
    candidateId: c.candidateId,
    title: c.title,
    validationState: c.validationState,
    reasons: c.reasons,
    warnings: c.warnings,
    excluded: c.excludedPlaceIds.map(id => ({ placeId: id, name: names.get(id) ?? null })),
    totals: c.totalKnownCost,
    hasUnknownCost: c.hasUnknownCost,
    days: c.days.length,
    activityCount,
    durationSeconds: knownLegs > 0 ? known : null,
    durationPartial: unknownLegs > 0,
    adoptable: !NOT_ADOPTABLE.includes(c.validationState),
  };
}

/** K08 body for a NEW trip: tripId null and expectedRevision null. Strictly parsed so extra fields cannot slip in. */
export function buildApplyRequest(batchId: string, candidateId: string): ApplyCandidateRequest {
  return ApplyCandidateRequest.parse({ batchId, candidateId, tripId: null, expectedRevision: null });
}

/** UI review on #33: the next step is shown without the user having to scroll. Focus follows for screen readers. */
export function revealStep(
  el: { scrollIntoView(o?: ScrollIntoViewOptions): void; focus(o?: FocusOptions): void } | null,
  reducedMotion: boolean,
): void {
  if (!el) return;
  el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}

/** UI review on #33: after adopting, open the U04 map of the new trip from the top of the page. */
export function openMap(href: string, win: { scrollTo(x: number, y: number): void; location: { hash: string } }): void {
  win.scrollTo(0, 0);
  win.location.hash = href;
}
