/**
 * U03 conditions: pure state and request building on top of the U01 prototype logic (../condition.ts).
 * The K01 body is built only from contract fields (GenerateRequest / TripConstraints); nothing is invented
 * and unknown values stay absent or null (budget unknown is null, never 0).
 */
import { GenerateRequest, TripConstraints } from '@tkb/contracts';
import type { PlaceInfo, TransportMode } from '@tkb/contracts';
import {
  FIELD_LABEL,
  MAX_PREFERENCES,
  MAX_PREFERENCE_LENGTH,
  emptyForm,
  isRealDate,
  parseBudget,
  sampleForm,
  validateCondition,
  type ConditionForm,
  type FieldKey,
} from '../condition.ts';

/** trip.ts: mustVisit is at most 30 place ids. */
export const MAX_MUST_VISIT = 30;
/** Per-day overrides are offered for trips up to this many days (longer trips use the default mode only). */
export const MAX_DAYS_FOR_PER_DAY = 31;
/** Budget currencies offered. The budget is a single Money: one currency per trip, never mixed. */
export const BUDGET_CURRENCIES = ['JPY', 'USD', 'EUR', 'GBP', 'KRW', 'TWD', 'AUD', 'CAD', 'CNY', 'THB', 'SGD'] as const;

/** Stated wishes for R13 (fixed restaurant visit vs area-level free walking), sent as preferences text. */
export const MEAL_PREFERENCE = '食事: 固定の店舗での食事を予定に含めたい';
export const FREE_WALK_PREFERENCE = '自由散策: 店舗を決めないエリア単位の散策・食べ歩きを予定に含めたい';

export interface ConditionsForm {
  /** U01 fields (area, dates, zone, default mode, budget, unresolved must-visit text). */
  base: ConditionForm;
  /** Must-visit places chosen from K05 results (resolved place ids). */
  selected: PlaceInfo[];
  /** Per-day mode overrides keyed by local date (trip time zone). Only dates inside the trip are sent. */
  modeByDate: Record<string, TransportMode>;
  meal: boolean;
  freeWalk: boolean;
  /** R01 出発・帰着条件: free text labels (no place id or time is invented). */
  departureLabel: string;
  returnLabel: string;
}

export type ConditionsFieldKey = FieldKey | 'modeByDate' | 'selected' | 'preferences' | 'departure' | 'return';

export const CONDITIONS_LABEL: Record<ConditionsFieldKey, string> = {
  ...FIELD_LABEL,
  modeByDate: '日ごとの交通手段',
  selected: '必須地点（選択）',
  preferences: '希望条件',
  departure: '出発条件',
  return: '帰着条件',
};

export const emptyConditions: ConditionsForm = {
  base: emptyForm,
  selected: [],
  modeByDate: {},
  meal: false,
  freeWalk: false,
  departureLabel: '',
  returnLabel: '',
};

export const sampleConditions: ConditionsForm = { ...emptyConditions, base: sampleForm };

export type ConditionsErrors = Partial<Record<ConditionsFieldKey, string>>;

export interface ConditionsResult {
  errors: ConditionsErrors;
  missing: FieldKey[];
  request: GenerateRequest | null;
  /** Non-blocking notices (e.g. a selected place in another time zone). */
  warnings: string[];
}

/** Local calendar dates from start to end inclusive (YYYY-MM-DD). Empty when the range is invalid or too long. */
export function tripDates(startDate: string, endDate: string, max = MAX_DAYS_FOR_PER_DAY): string[] {
  if (!isRealDate(startDate) || !isRealDate(endDate) || endDate < startDate) return [];
  const out: string[] = [];
  const d = new Date(`${startDate}T00:00:00Z`);
  while (out.length <= max) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > endDate) return out;
    out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return []; // longer than max days
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** "11/1(日)" for a local date. A calendar date has no zone, so the weekday does not depend on the device zone. */
export function formatLocalDate(date: string): string {
  if (!isRealDate(date)) return date;
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
}

/** Today's calendar date in the trip's time zone (not the device's). null when the zone is not valid. */
export function todayIn(timeZone: string, now: Date = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return null;
  }
}

/** Formats a typed budget for the confirmation line, in its own currency only. null when not a valid amount. */
export function formatBudgetPreview(amount: string, currency: string): string | null {
  const money = parseBudget(amount, currency);
  if (!money) return null;
  const digits = new Intl.NumberFormat('ja-JP', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 0;
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency }).format(money.amountMinor / 10 ** digits);
}

/** Adds a K05 place as must-visit (no duplicates, at most 30). Returns the same object when nothing changes. */
export function addMustVisit(form: ConditionsForm, place: PlaceInfo): ConditionsForm {
  if (form.selected.some(p => p.placeId === place.placeId) || form.selected.length >= MAX_MUST_VISIT) return form;
  return { ...form, selected: [...form.selected, place] };
}

export function removeMustVisit(form: ConditionsForm, placeId: string): ConditionsForm {
  if (!form.selected.some(p => p.placeId === placeId)) return form;
  return { ...form, selected: form.selected.filter(p => p.placeId !== placeId) };
}

/** Sets one day's mode; choosing the default mode removes the override. */
export function setModeForDate(form: ConditionsForm, date: string, mode: TransportMode | 'default'): ConditionsForm {
  const next = { ...form.modeByDate };
  if (mode === 'default' || mode === form.base.transportMode) delete next[date];
  else next[date] = mode;
  return { ...form, modeByDate: next };
}

/** Effective per-day overrides: only dates inside the trip and different from the default mode. */
export function effectiveModeByDate(form: ConditionsForm): Record<string, TransportMode> {
  const dates = new Set(tripDates(form.base.startDate, form.base.endDate));
  const out: Record<string, TransportMode> = {};
  for (const [date, mode] of Object.entries(form.modeByDate)) {
    if (dates.has(date) && mode !== form.base.transportMode) out[date] = mode;
  }
  return out;
}

function sameKeys(sent: object, kept: object): boolean {
  const a = Object.keys(sent).sort().join(',');
  return a === Object.keys(kept).sort().join(',');
}

/** Validates everything and builds the exact K01 body. request is null while anything is wrong. */
export function buildConditionsRequest(form: ConditionsForm, now: Date = new Date()): ConditionsResult {
  const baseResult = validateCondition(form.base);
  const errors: ConditionsErrors = { ...baseResult.errors };
  const warnings: string[] = [];

  if (form.selected.length > MAX_MUST_VISIT) errors.selected = `必須地点は${MAX_MUST_VISIT}件までです。`;
  const zone = form.base.timeZone.trim();
  const otherZone = form.selected.filter(p => zone !== '' && p.timeZone !== zone);
  if (otherZone.length > 0) {
    warnings.push(`選択した地点のうち ${otherZone.map(p => `${p.name}（${p.timeZone}）`).join('、')} は旅行のタイムゾーン（${zone}）と異なります。`);
  }

  const dates = tripDates(form.base.startDate, form.base.endDate);
  const overrides = Object.keys(form.modeByDate);
  if (overrides.length > 0 && form.base.transportMode === '') {
    errors.modeByDate = '日ごとの交通手段を使うには、先に基本の交通手段を選んでください。';
  }
  const outside = overrides.filter(d => dates.length > 0 && !dates.includes(d));
  if (outside.length > 0) warnings.push(`旅行期間外の日付（${outside.join('、')}）の交通手段指定は送信しません。`);

  const today = zone !== '' ? todayIn(zone, now) : null;
  if (today && isRealDate(form.base.startDate) && form.base.startDate < today) {
    warnings.push(`開始日（${form.base.startDate}）は現地（${zone}）の今日 ${today} より前です。`);
  }

  const departure = form.departureLabel.trim();
  const ret = form.returnLabel.trim();
  if (departure.length > 200) errors.departure = '出発条件は200文字以内で入力してください。';
  if (ret.length > 200) errors.return = '帰着条件は200文字以内で入力してください。';

  const base = baseResult.request;
  const extraPrefs = [...(form.meal ? [MEAL_PREFERENCE] : []), ...(form.freeWalk ? [FREE_WALK_PREFERENCE] : [])];
  const prefs = [...(base?.constraints.preferences ?? []), ...extraPrefs];
  if (prefs.length > MAX_PREFERENCES) errors.preferences = `希望条件（未解決の必須地点と食事・散策の希望）は合計${MAX_PREFERENCES}件までです（現在 ${prefs.length} 件）。`;
  if (prefs.some(p => p.length > MAX_PREFERENCE_LENGTH)) errors.preferences = `希望条件は1件${MAX_PREFERENCE_LENGTH}文字までです。`;

  if (Object.keys(errors).length > 0 || !base) return { errors, missing: baseResult.missing, request: null, warnings };

  const modeByDate = effectiveModeByDate(form);
  const constraints = {
    ...base.constraints,
    ...(prefs.length > 0 ? { preferences: prefs } : {}),
    ...(form.selected.length > 0 ? { mustVisit: form.selected.map(p => p.placeId) } : {}),
    ...(Object.keys(modeByDate).length > 0 ? { transportModeByDate: modeByDate } : {}),
    ...(departure ? { departure: { placeId: null, label: departure, time: null } } : {}),
    ...(ret ? { return: { placeId: null, label: ret, time: null } } : {}),
  };
  const body = { mode: 'generate' as const, constraints };
  const parsed = GenerateRequest.safeParse(body);
  // TripConstraints strips unknown keys silently; insist that nothing was stripped (strict like the server).
  const constraintsParsed = TripConstraints.safeParse(constraints);
  if (!parsed.success || !constraintsParsed.success || !sameKeys(constraints, constraintsParsed.data)) {
    const msg = parsed.success ? '未知の項目が含まれています。' : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' / ');
    return { errors: { preferences: `入力が契約(K01)に適合しません: ${msg}` }, missing: baseResult.missing, request: null, warnings };
  }
  return { errors, missing: baseResult.missing, request: parsed.data, warnings };
}

/** Idempotency-Key for K01 (8 to 128 of [A-Za-z0-9_-]). One key per distinct body, so a retry reuses the job. */
export function newIdempotencyKey(random: () => string = () => crypto.randomUUID()): string {
  return `u03_${random().replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 128);
}
