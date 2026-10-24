/**
 * R01 condition form: pure state/validation. The request is built exactly per
 * packages/contracts (GenerateRequest / TripConstraints); no field is invented.
 */
import { GenerateRequest, TimeZone } from '@tkb/contracts';
import type { Money, TransportMode } from '@tkb/contracts';

export interface ConditionForm {
  area: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  transportMode: TransportMode | '';
  /** 'unknown' sends budget: null (explicitly unknown); it is never turned into 0. */
  budgetMode: 'amount' | 'unknown';
  budgetAmount: string;
  budgetCurrency: string;
  /** One place per line (or comma separated). */
  mustVisit: string;
}

export type FieldKey = 'area' | 'startDate' | 'endDate' | 'timeZone' | 'transportMode' | 'budget' | 'mustVisit';

export const REQUIRED_FIELDS: readonly FieldKey[] = ['area', 'startDate', 'endDate', 'timeZone', 'transportMode'];

export const FIELD_LABEL: Record<FieldKey, string> = {
  area: '地域',
  startDate: '開始日',
  endDate: '終了日',
  timeZone: 'タイムゾーン',
  transportMode: '交通手段',
  budget: '予算',
  mustVisit: '必須地点',
};

export const TIME_ZONE_SUGGESTIONS = ['Asia/Tokyo', 'Asia/Seoul', 'Asia/Taipei', 'Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];
/** Prefix of every typed 必須地点 sent as a preference (the name is not resolved to a placeId). */
export const MUST_VISIT_PREFIX = '必須地点（名称・地点ID未解決）: ';
/** trip.ts: preferences are at most 20 items of at most 200 characters. */
export const MAX_PREFERENCES = 20;
export const MAX_PREFERENCE_LENGTH = 200;
export const CURRENCIES = ['JPY', 'EUR', 'USD'] as const;

export const emptyForm: ConditionForm = {
  area: '',
  startDate: '',
  endDate: '',
  // Required: left empty until the user picks one (nothing is confirmed silently).
  timeZone: '',
  transportMode: '',
  budgetMode: 'unknown',
  budgetAmount: '',
  budgetCurrency: 'JPY',
  mustVisit: '',
};

/** One-click sample for reviewers (same area and dates as the mock's fixture candidates). */
export const sampleForm: ConditionForm = {
  area: '金沢',
  startDate: '2026-11-01',
  endDate: '2026-11-02',
  timeZone: 'Asia/Tokyo',
  transportMode: 'transit',
  budgetMode: 'unknown',
  budgetAmount: '',
  budgetCurrency: 'JPY',
  mustVisit: '',
};

export type FieldErrors = Partial<Record<FieldKey, string>>;

export interface ConditionResult {
  errors: FieldErrors;
  /** Fields among REQUIRED_FIELDS that are still empty (for the always-visible checklist). */
  missing: FieldKey[];
  request: GenerateRequest | null;
}

export function splitMustVisit(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,、]/)) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** Money in minor units from a typed amount; null when not a valid amount for the currency. */
export function parseBudget(amount: string, currency: string): Money | null {
  const text = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  let digits: number;
  try {
    digits = new Intl.NumberFormat('ja-JP', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 0;
  } catch {
    return null;
  }
  const scaled = Number(text) * 10 ** digits;
  const minor = Math.round(scaled);
  if (!Number.isSafeInteger(minor) || Math.abs(scaled - minor) > 1e-6) return null;
  return { amountMinor: minor, currency };
}

function isEmpty(value: string): boolean {
  return value.trim() === '';
}

export function validateCondition(form: ConditionForm): ConditionResult {
  const errors: FieldErrors = {};
  const missing: FieldKey[] = [];

  const area = form.area.trim();
  if (isEmpty(form.area)) {
    errors.area = '地域を入力してください。';
    missing.push('area');
  } else if (area.length > 200) errors.area = '地域は200文字以内で入力してください。';

  if (isEmpty(form.startDate)) {
    errors.startDate = '開始日を選んでください。';
    missing.push('startDate');
  }
  if (isEmpty(form.endDate)) {
    errors.endDate = '終了日を選んでください。';
    missing.push('endDate');
  } else if (!isEmpty(form.startDate) && form.endDate < form.startDate) {
    errors.endDate = '終了日は開始日以降にしてください。';
  }

  if (isEmpty(form.timeZone)) {
    errors.timeZone = 'タイムゾーンを入力してください（例: Asia/Tokyo）。';
    missing.push('timeZone');
  } else if (!TimeZone.safeParse(form.timeZone.trim()).success) {
    errors.timeZone = 'IANAタイムゾーン名で入力してください（例: Asia/Tokyo。+09:00 のような表記は使えません）。';
  }

  if (form.transportMode === '') {
    errors.transportMode = '交通手段（公共交通または車）を選んでください。';
    missing.push('transportMode');
  }

  let budget: Money | null = null;
  if (form.budgetMode === 'amount') {
    budget = parseBudget(form.budgetAmount, form.budgetCurrency);
    if (isEmpty(form.budgetAmount)) errors.budget = '予算の金額を入力するか、「不明」を選んでください。';
    else if (!budget) errors.budget = '予算は0以上の数値で入力してください（通貨の小数桁を超える指定は不可）。';
  }

  const entries = splitMustVisit(form.mustVisit);
  // No place picker exists yet, so typed text is never a verified placeId: every entry is sent as a stated
  // preference and mustVisit stays empty (it is omitted from the request).
  const preferences = entries.map(e => `${MUST_VISIT_PREFIX}${e}`);
  const longest = entries.find(e => `${MUST_VISIT_PREFIX}${e}`.length > MAX_PREFERENCE_LENGTH);
  if (preferences.length > MAX_PREFERENCES) errors.mustVisit = `必須地点は${MAX_PREFERENCES}件までです（現在 ${preferences.length} 件）。`;
  else if (longest !== undefined) {
    errors.mustVisit = `「${longest.slice(0, 20)}…」が長すぎます（1件あたり${MAX_PREFERENCE_LENGTH - MUST_VISIT_PREFIX.length}文字まで）。`;
  }

  if (Object.keys(errors).length > 0) return { errors, missing, request: null };

  const parsed = GenerateRequest.safeParse({
    mode: 'generate',
    constraints: {
      area,
      startDate: form.startDate,
      endDate: form.endDate,
      timeZone: form.timeZone.trim(),
      transportMode: form.transportMode,
      budget: form.budgetMode === 'amount' ? budget : null,
      ...(preferences.length > 0 ? { preferences } : {}),
    },
  });
  if (!parsed.success) {
    // Contract rejected something the checks above did not foresee: show it instead of sending.
    return { errors: { area: `入力が契約に適合しません: ${parsed.error.issues.map(i => i.message).join(' / ')}` }, missing, request: null };
  }
  return { errors, missing, request: parsed.data };
}
