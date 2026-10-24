/**
 * Extra fixture cases for screens: empty, unknown budget, failure, cancelled job, car, candidate comparison.
 * Waiting states are sampleJobStatuses.queued/running in index.ts and the mock API's 'slow' scenario.
 * Same rules as index.ts: NOT verified travel information. Unknown values stay `null`, never 0.
 *
 * index.ts re-exports this file, so anything built from index.ts values is a function
 * (evaluated at call time) to stay safe with the circular import. Functions return fresh copies;
 * sampleApiErrors and extraJobStatuses are shared constants and must not be mutated.
 */
import type {
  ApiError,
  ErrorCode,
  Feed,
  JobStatus,
  Money,
  PlanBatch,
  PlanCandidate,
  PostSummary,
  Trip,
  TripList,
} from '@tkb/contracts';
import { domesticTrip, kanazawaPlaces, overseasTrip, sampleFeed } from './index.ts';

type Days = Trip['days'];

// ---------- Cost helpers ----------

export interface KnownCostSummary {
  /** Known amounts summed per currency (minor units). Currencies are never merged (R11). */
  totalKnownCost: Money[];
  /** True when any activity cost or leg fare is null. Unknown is never counted as 0. */
  hasUnknownCost: boolean;
}

/** Same rule as apps/web costs.ts: a null cost/fare is unknown, everything else is summed per currency. */
export function summarizeKnownCost(days: Days): KnownCostSummary {
  const byCurrency = new Map<string, number>();
  let hasUnknownCost = false;
  for (const day of days) {
    for (const item of day.items) {
      const money = item.type === 'activity' ? item.cost : item.fare;
      if (money === null) {
        hasUnknownCost = true;
        continue;
      }
      byCurrency.set(money.currency, (byCurrency.get(money.currency) ?? 0) + money.amountMinor);
    }
  }
  const totalKnownCost = [...byCurrency.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return { totalKnownCost, hasUnknownCost };
}

/** Copy of `days` where every cost and fare is unknown (null, costStatus 'unknown'). */
export function withUnknownCosts(days: Days): Days {
  return days.map(day => ({
    ...day,
    items: day.items.map(item =>
      item.type === 'activity'
        ? { ...item, cost: null, costStatus: 'unknown' as const }
        : { ...item, fare: null },
    ),
  }));
}

// ---------- Trips ----------

/** Domestic trip whose budget, costs and fares are all unknown. */
export function createBudgetUnknownTrip(): Trip {
  const base = structuredClone(domesticTrip);
  return {
    ...base,
    tripId: 'fx_trip_budget_unknown',
    title: '金沢 1泊2日・予算不明（fixture）',
    constraints: { ...base.constraints, budget: null },
    days: withUnknownCosts(base.days),
    warnings: ['予算と費用・運賃は未取得です（fixture）'],
  };
}

/** Overseas (Paris) trip with no budget and every cost/fare null. Keeps the DST-crossing times. */
export function createBudgetUnknownOverseasTrip(): Trip {
  const base = structuredClone(overseasTrip);
  return {
    ...base,
    tripId: 'fx_trip_paris_budget_unknown',
    title: 'パリ 2日間・予算不明（fixture・夏時間終了をまたぐ）',
    constraints: { ...base.constraints, budget: null },
    days: withUnknownCosts(base.days),
    warnings: ['予算と費用・運賃は未取得です（fixture）'],
  };
}

/** Domestic trip by car: every transit leg becomes a car leg; no fare (fuel/toll are unknown). */
export function createCarTrip(): Trip {
  const base = structuredClone(domesticTrip);
  return {
    ...base,
    tripId: 'fx_trip_kanazawa_car',
    title: '金沢 1泊2日・車移動（fixture）',
    constraints: { ...base.constraints, transportMode: 'car' },
    days: base.days.map(day => ({
      ...day,
      items: day.items.map(item =>
        item.type === 'leg' && item.mode === 'transit' ? { ...item, mode: 'car' as const, lineName: null, fare: null } : item,
      ),
    })),
    warnings: ['車移動の燃料・高速料金は未取得です（fixture）'],
  };
}

/** A trip whose days exist but have no items yet (the "add your first activity" state). */
export function createEmptyItemsTrip(): Trip {
  const base = structuredClone(domesticTrip);
  return {
    ...base,
    tripId: 'fx_trip_empty_items',
    title: '金沢・予定なし（fixture）',
    days: base.days.map(day => ({ ...day, items: [] })),
    places: [],
    validationState: 'valid',
    warnings: [],
  };
}

/** A trip with no days at all (days = []). */
export function createNoDaysTrip(): Trip {
  return { ...createEmptyItemsTrip(), tripId: 'fx_trip_no_days', title: '金沢・日程なし（fixture）', days: [] };
}

export const emptyTripList: TripList = { items: [], nextCursor: null };
export const emptyFeed: Feed = { items: [], nextCursor: null };

// ---------- Plan batch for candidate comparison (K07) ----------

/** Items of the Kanazawa fixture by id, so candidates are assembled from the existing sample. */
function kanazawaItems(): Map<string, Days[number]['items'][number]> {
  const map = new Map<string, Days[number]['items'][number]>();
  for (const day of structuredClone(domesticTrip).days) {
    for (const item of day.items) map.set(item.type === 'activity' ? item.activityId : item.legId, item);
  }
  return map;
}

function candidate(
  candidateId: string,
  title: string,
  dayItemIds: string[][],
  extra: Pick<PlanCandidate, 'reasons' | 'warnings' | 'excludedPlaceIds' | 'validationState'>,
): PlanCandidate {
  const items = kanazawaItems();
  const days: Days = dayItemIds.map((ids, i) => {
    const day = domesticTrip.days[i];
    if (!day) throw new Error(`fixture day ${i} missing`);
    return {
      date: day.date,
      timeZone: day.timeZone,
      items: ids.map(id => {
        const item = items.get(id);
        if (!item) throw new Error(`fixture item ${id} missing`);
        return item;
      }),
    };
  });
  return { candidateId, title, days, ...summarizeKnownCost(days), ...extra };
}

/** Three candidates: unknown costs on 1 and 2, all costs known on 3 (hasUnknownCost=false). */
export function createSamplePlanBatch(): PlanBatch {
  return {
    batchId: 'fx_batch_1',
    baseTripId: null,
    baseRevision: null,
    candidates: [
      candidate('candidate_1', '庭園と美術館を優先（fixture）', [
        ['fx_leg_1', 'fx_act_kenrokuen', 'fx_leg_2', 'fx_act_museum', 'fx_leg_3', 'fx_act_lunch', 'fx_act_omicho'],
        ['fx_act_higashi'],
      ], {
        reasons: ['必須地点の兼六園を午前に配置'],
        warnings: ['美術館の入館料と一部の移動は未取得'],
        excludedPlaceIds: [],
        validationState: 'needs_review',
      }),
      candidate('candidate_2', '茶屋街を優先（fixture）', [
        ['fx_leg_1', 'fx_act_kenrokuen', 'fx_act_lunch', 'fx_act_omicho'],
        ['fx_act_higashi'],
      ], {
        reasons: ['移動を減らすため美術館を除外'],
        warnings: ['近江町市場・ひがし茶屋街の費用は未取得'],
        excludedPlaceIds: ['fx_21c_museum'],
        validationState: 'needs_review',
      }),
      candidate('candidate_3', 'ゆったり1日（fixture）', [['fx_leg_1', 'fx_act_kenrokuen', 'fx_act_lunch'], []], {
        reasons: ['予定を絞り、費用が分かる項目だけにした'],
        warnings: [],
        excludedPlaceIds: ['fx_21c_museum', 'fx_omicho', 'fx_higashi'],
        validationState: 'valid',
      }),
    ],
    places: structuredClone(kanazawaPlaces),
    createdAt: '2026-10-24T00:00:30Z',
  };
}

/** The same batch with every cost and fare unknown (budget-unknown screens). */
export function createBudgetUnknownPlanBatch(): PlanBatch {
  const batch = createSamplePlanBatch();
  return {
    ...batch,
    batchId: 'fx_batch_budget_unknown',
    candidates: batch.candidates.map(c => {
      const days = withUnknownCosts(c.days);
      return { ...c, days, ...summarizeKnownCost(days) };
    }),
  };
}

// ---------- Failures and waiting ----------

function apiError(code: ErrorCode, message: string, retryable: boolean, details?: Record<string, unknown>): ApiError {
  return { code, message, retryable, requestId: `req_fx_${code.toLowerCase()}`, ...(details ? { details } : {}) };
}

/** K23 samples. Not-found never reveals whether another user's resource exists. */
export const sampleApiErrors = {
  UNAUTHENTICATED: apiError('UNAUTHENTICATED', 'ログインしてください。', false),
  FORBIDDEN: apiError('FORBIDDEN', 'この操作は許可されていません。', false),
  NOT_FOUND: apiError('NOT_FOUND', '見つかりませんでした。', false),
  REVISION_CONFLICT: apiError('REVISION_CONFLICT', '他の端末で更新されています。再読込して変更を確認してください。', false, { expectedRevision: 1, currentRevision: 2 }),
  ALREADY_COMMITTED: apiError('ALREADY_COMMITTED', '保存済みのため取り消せません。', false),
  VALIDATION_FAILED: apiError('VALIDATION_FAILED', '入力内容を確認してください。', false),
  RATE_LIMITED: apiError('RATE_LIMITED', '操作が多すぎます。しばらくしてから再度お試しください。', true),
  UNAVAILABLE: apiError('UNAVAILABLE', 'サーバーに接続できません。', true),
  AI_UNAVAILABLE: apiError('AI_UNAVAILABLE', 'AIによる生成は現在利用できません。手動で旅程を作成できます。', false, { reason: 'CLAUDE_EXECUTION_DISABLED' }),
  PROVIDER_UNAVAILABLE: apiError('PROVIDER_UNAVAILABLE', '地図・乗換データを取得できませんでした。費用と所要時間は未取得として表示します。', true),
  INVALID_OUTPUT: apiError('INVALID_OUTPUT', '生成結果の形式が不正でした。', true),
} as const satisfies Partial<Record<ErrorCode, ApiError>>;

/**
 * Job states not covered by sampleJobStatuses in index.ts
 * (which has queued, running, succeeded and failed with CLI_TIMEOUT).
 */
export const extraJobStatuses = {
  cancelled: { jobId: 'fx_job_3', state: 'cancelled', stage: 'generating', batchId: null, error: null, updatedAt: '2026-10-24T00:01:00Z' },
  failedInvalidOutput: {
    jobId: 'fx_job_4',
    state: 'failed',
    stage: 'validating',
    batchId: null,
    error: { code: 'INVALID_OUTPUT', message: sampleApiErrors.INVALID_OUTPUT.message, retryable: true, requestId: 'req_fx_invalid_output' },
    updatedAt: '2026-10-24T00:02:00Z',
  },
  failedAiUnavailable: {
    jobId: 'fx_job_5',
    state: 'failed',
    stage: 'queued',
    batchId: null,
    error: { code: 'AI_UNAVAILABLE', message: sampleApiErrors.AI_UNAVAILABLE.message, retryable: false, requestId: 'req_fx_ai_unavailable' },
    updatedAt: '2026-10-24T00:00:10Z',
  },
} as const satisfies Record<string, JobStatus>;

// ---------- Feed (K14) ----------

/** Several posts so screens can test pagination. Authors and stories are fictional. */
export function createSampleFeedPosts(): PostSummary[] {
  const first = structuredClone(sampleFeed.items);
  const more: PostSummary[] = [
    {
      postId: 'fx_post_2',
      postRevision: 1,
      authorDisplayName: 'デモ利用者B',
      title: 'パリ 2日間（fixture）',
      story: 'パリの旅行記録（fixture）',
      visibility: 'public',
      groupId: null,
      area: 'Paris',
      startDate: '2026-10-24',
      createdAt: '2026-10-24T01:00:00Z',
    },
    {
      postId: 'fx_post_3',
      postRevision: 2,
      authorDisplayName: 'デモ利用者A',
      title: '金沢 車移動（fixture）',
      story: '車で巡る金沢（fixture）',
      visibility: 'public',
      groupId: null,
      area: '金沢',
      startDate: '2026-11-08',
      createdAt: '2026-10-24T02:00:00Z',
    },
  ];
  return [...first, ...more];
}
