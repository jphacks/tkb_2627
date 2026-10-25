import { useEffect, useMemo, useRef, useState } from 'react';
import { TimeZone } from '@tkb/contracts';
import type { Capabilities, DataStatus, GenerateRequest, JobAccepted, PlaceInfo, TransportMode } from '@tkb/contracts';
import { ErrorBox, type ErrorInfo } from '../../components/ErrorBox.tsx';
import { ScreenHeader } from '../../components/ScreenHeader.tsx';
import { TRANSPORT_LABEL, UNKNOWN_LABEL } from '../../components/labels.ts';
import { REQUIRED_FIELDS, type ConditionForm } from '../condition.ts';
import { describeError, type ApiResult, type ConditionsApi, type DataSource } from './api.ts';
import {
  BUDGET_CURRENCIES,
  CONDITIONS_LABEL,
  FREE_WALK_PREFERENCE,
  MAX_MUST_VISIT,
  MEAL_PREFERENCE,
  addMustVisit,
  buildConditionsRequest,
  effectiveModeByDate,
  emptyConditions,
  formatBudgetPreview,
  formatLocalDate,
  newIdempotencyKey,
  removeMustVisit,
  sampleConditions,
  setModeForDate,
  todayIn,
  tripDates,
  type ConditionsFieldKey,
  type ConditionsForm,
} from './model.ts';
import { DEFAULT_ZONE, buildZoneGroups, zoneForArea, zoneLabel } from './tz.ts';
import './tz.css';

const DATA_STATUS_LABEL: Record<DataStatus, string> = {
  verified: '確認済み',
  fixture: 'サンプル(fixture)',
  unknown: '不明',
  unavailable: '取得不可',
  unsupported_region: '対象外地域',
};

const KIND_LABEL: Record<PlaceInfo['kind'], string> = {
  spot: '観光地',
  restaurant: '食事（固定店舗）',
  area: 'エリア（自由散策向き）',
  station: '駅',
  lodging: '宿泊',
  toilet: 'トイレ',
  shelter: '避難所',
  other: 'その他',
};

const AI_REASON_LABEL: Record<string, string> = {
  SHARED_ENTRY_NO_PERSONAL_CLAUDE: '共有入口からは生成できません（本人用アプリから操作してください）。',
  CLAUDE_EXECUTION_DISABLED: '本人用アプリでClaude実行が無効になっています。',
  CLI_NOT_FOUND: 'Claude Code CLI が見つかりません。',
  CLI_NOT_AUTHENTICATED: 'Claude Code CLI にログインしていません。',
  TERMS_NOT_CONFIRMED: '利用条件の確認が済んでいません。',
};

const defaultConditions: ConditionsForm = { ...emptyConditions, base: { ...emptyConditions.base, timeZone: DEFAULT_ZONE } };

const toErrorInfo = (r: Extract<ApiResult<unknown>, { ok: false }>): ErrorInfo => ({
  message: describeError(r.error),
  code: r.error.code,
  retryable: r.error.retryable,
  requestId: r.error.requestId,
});

/** Source / attribution badge from PlaceInfo.provenance (R02). */
export function PlaceSourceBadge({ place }: { place: PlaceInfo }) {
  const p = place.provenance;
  return (
    <span className="u1-source" title="地点情報の出典">
      出典: {p.source}
      {p.attribution ? ` / ${p.attribution}` : ''}（{DATA_STATUS_LABEL[place.dataStatus]}）
    </span>
  );
}

export function PlaceCard({ place, selected, disabled, onToggle, tripZone }: {
  place: PlaceInfo;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
  tripZone: string;
}) {
  return (
    <li className="u1-card">
      <p><strong>{place.name}</strong> <span className="meta">{KIND_LABEL[place.kind]}</span></p>
      {place.photo && (
        <figure style={{ margin: '4px 0' }}>
          <img src={place.photo.url} alt={place.name} loading="lazy" style={{ maxWidth: '100%', height: 'auto' }} />
          <figcaption className="meta">写真: {place.photo.attribution}{place.photo.license ? `（${place.photo.license}）` : ''}</figcaption>
        </figure>
      )}
      {place.description && <p className="meta">{place.description}</p>}
      <p className="meta">営業時間: {place.openingHours ?? <span className="u1-unknown">{UNKNOWN_LABEL}</span>}</p>
      {tripZone !== '' && place.timeZone !== tripZone && <p className="u1-fielderr">タイムゾーンが旅行（{tripZone}）と異なります: {place.timeZone}</p>}
      <p><PlaceSourceBadge place={place} /></p>
      <button type="button" className={selected ? 'btn u1-danger' : 'btn'} aria-pressed={selected} disabled={!selected && disabled} onClick={onToggle}>
        {selected ? `必須地点から外す（${place.name}）` : `必須地点に追加（${place.name}）`}
      </button>
    </li>
  );
}

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; places: PlaceInfo[]; unknown: string[]; dataMode: string; source: DataSource }
  | { status: 'error'; error: ErrorInfo };

export type CapabilityState = { status: 'loading' } | { status: 'done'; data: Capabilities } | { status: 'error'; error: ErrorInfo };

export interface ConditionsViewProps {
  form: ConditionsForm;
  onChange: (next: ConditionsForm) => void;
  onSubmit: () => void;
  onSearch: () => void;
  searchArea: string;
  onSearchAreaChange: (v: string) => void;
  search: SearchState;
  capability: CapabilityState;
  submitted: boolean;
  busy: boolean;
  submitError: ErrorInfo | null;
  accepted: JobAccepted | null;
  source: DataSource;
  now?: Date;
}

/** Presentational U03 form (renderable without a DOM for tests). */
export function ConditionsView(props: ConditionsViewProps) {
  const { form, onChange, submitted, busy, search, capability, submitError, accepted, source } = props;
  const result = buildConditionsRequest(form, props.now);
  const shown = submitted ? result.errors : {};
  const errorKeys = Object.keys(shown) as ConditionsFieldKey[];
  const b = form.base;
  const setBase = <K extends keyof ConditionForm>(key: K, value: ConditionForm[K]) => onChange({ ...form, base: { ...b, [key]: value } });
  const setArea = (area: string) => {
    // 地域から既知のゾーンが分かり、利用者が変えていない（空・既定・前の地域由来）なら、そのゾーンを選んでおく。
    const next = zoneForArea(area);
    const cur = b.timeZone.trim();
    const untouched = cur === '' || cur === DEFAULT_ZONE || cur === zoneForArea(b.area);
    onChange({ ...form, base: { ...b, area, ...(next && untouched ? { timeZone: next } : {}) } });
  };
  const zone = b.timeZone.trim();
  const zoneGroups = useMemo(() => buildZoneGroups(props.now), [props.now]);
  const zoneInGroups = zoneGroups.some(g => g.zones.some(o => o.value === zone));
  const dates = tripDates(b.startDate, b.endDate);
  const overrides = effectiveModeByDate(form);
  const today = zone ? todayIn(zone, props.now) : null;
  const budgetPreview = b.budgetMode === 'amount' ? formatBudgetPreview(b.budgetAmount, b.budgetCurrency) : null;
  const aiUnavailable = capability.status === 'done' && !capability.data.aiGeneration.available;
  const searchReady = (props.searchArea.trim() || b.area.trim()) !== '' && b.transportMode !== '';
  const selectedIds = new Set(form.selected.map(p => p.placeId));

  return (
    <form className="u1-form" noValidate onSubmit={e => { e.preventDefault(); props.onSubmit(); }}>
      <p>
        <span className="u1-source">{source === 'mock' ? 'モックAPI（送信・保存なし）' : '実API（本人用App Server / 共有サーバー）'}</span>
      </p>

      <div aria-live="polite">
        {capability.status === 'loading' && <p className="u1-loading">AI生成の利用可否を確認中…</p>}
        {capability.status === 'error' && <ErrorBox title="本人用アプリの状態を取得できません（入力は続けられます）" error={capability.error} />}
        {aiUnavailable && capability.status === 'done' && (
          <div role="alert" className="u1-error">
            <strong>AI生成は現在利用できません（入力は続けられます）</strong>
            <p>{capability.data.aiGeneration.reason ? (AI_REASON_LABEL[capability.data.aiGeneration.reason] ?? capability.data.aiGeneration.reason) : '理由は不明です。'}</p>
            <p className="meta">理由コード: {capability.data.aiGeneration.reason ?? UNKNOWN_LABEL} / runner: {capability.data.aiGeneration.runner}</p>
          </div>
        )}
        {capability.status === 'done' && capability.data.aiGeneration.available && (
          <p className="meta">AI生成: 利用可（runner: {capability.data.aiGeneration.runner}{capability.data.aiGeneration.runner === 'fake' ? '・テスト用の偽生成' : ''}）/ データ: {capability.data.dataMode}</p>
        )}
      </div>

      {errorKeys.length > 0 && (
        <div role="alert" className="u1-error" tabIndex={-1}>
          <strong>入力内容を確認してください（{errorKeys.length}件）</strong>
          <ul>{errorKeys.map(k => <li key={k}>{CONDITIONS_LABEL[k]}: {shown[k]}</li>)}</ul>
        </div>
      )}

      <div className="u1-field">
        <label htmlFor="u3-area">地域（必須）</label>
        <input id="u3-area" type="text" value={b.area} placeholder="例: 金沢 / Paris" autoComplete="off" aria-invalid={Boolean(shown.area)}
          onChange={e => setArea(e.target.value)} />
        {shown.area && <p className="u1-fielderr">{shown.area}</p>}
      </div>

      <div className="u1-field">
        <label htmlFor="u3-tz">タイムゾーン（旅行先・IANA名・必須）</label>
        <select id="u3-tz" className="u3-tz" value={zone} aria-invalid={Boolean(shown.timeZone)} aria-describedby="u3-tz-chosen u3-tz-note"
          onChange={e => setBase('timeZone', e.target.value)}>
          {zone === '' && <option value="" disabled>選択してください</option>}
          {zone !== '' && !zoneInGroups && <option value={zone}>{zone}（一覧にありません）</option>}
          {zoneGroups.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.zones.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          ))}
        </select>
        <p id="u3-tz-chosen" className="u3-tz-chosen">{zone !== '' ? `選択中: ${zoneLabel(zone, props.now)}` : 'タイムゾーンを選んでください'}</p>
        <p id="u3-tz-note" className="meta">日付は旅行先の現地日付です{today ? `（現地の今日: ${today}）` : ''}。端末のタイムゾーンでは変換しません。</p>
        {shown.timeZone && <p className="u1-fielderr">{shown.timeZone}</p>}
      </div>

      <div className="u1-row2">
        <div className="u1-field">
          <label htmlFor="u3-start">開始日（現地・必須）</label>
          <input id="u3-start" type="date" value={b.startDate} aria-invalid={Boolean(shown.startDate)} onChange={e => setBase('startDate', e.target.value)} />
          {shown.startDate && <p className="u1-fielderr">{shown.startDate}</p>}
        </div>
        <div className="u1-field">
          <label htmlFor="u3-end">終了日（現地・必須）</label>
          <input id="u3-end" type="date" value={b.endDate} min={b.startDate || undefined} aria-invalid={Boolean(shown.endDate)} onChange={e => setBase('endDate', e.target.value)} />
          {shown.endDate && <p className="u1-fielderr">{shown.endDate}</p>}
        </div>
      </div>

      <fieldset className="u1-field u1-fieldset">
        <legend>基本の交通手段（必須）</legend>
        {(['transit', 'car'] as TransportMode[]).map(m => (
          <label key={m} className="u1-choice">
            <input type="radio" name="u3-mode" value={m} checked={b.transportMode === m} onChange={() => setBase('transportMode', m)} />
            {TRANSPORT_LABEL[m]}
          </label>
        ))}
        {shown.transportMode && <p className="u1-fielderr">{shown.transportMode}</p>}
      </fieldset>

      {dates.length > 1 && b.transportMode !== '' && (
        <fieldset className="u1-field u1-fieldset">
          <legend>日ごとの交通手段（任意）</legend>
          <p className="meta">指定しない日は基本の交通手段（{TRANSPORT_LABEL[b.transportMode]}）を使います。</p>
          {dates.map(d => (
            <div key={d} className="u1-field">
              <label htmlFor={`u3-day-${d}`}>{formatLocalDate(d)}（{d}）</label>
              <select id={`u3-day-${d}`} value={overrides[d] ?? 'default'}
                onChange={e => onChange(setModeForDate(form, d, e.target.value as TransportMode | 'default'))}>
                <option value="default">基本と同じ（{TRANSPORT_LABEL[b.transportMode as TransportMode]}）</option>
                {(['transit', 'car'] as TransportMode[]).filter(m => m !== b.transportMode).map(m => (
                  <option key={m} value={m}>{TRANSPORT_LABEL[m]}に切り替える</option>
                ))}
              </select>
            </div>
          ))}
          {shown.modeByDate && <p className="u1-fielderr">{shown.modeByDate}</p>}
        </fieldset>
      )}

      <fieldset className="u1-field u1-fieldset">
        <legend>予算（任意・1つの通貨）</legend>
        <label className="u1-choice">
          <input type="radio" name="u3-budget" checked={b.budgetMode === 'unknown'} onChange={() => setBase('budgetMode', 'unknown')} />
          {UNKNOWN_LABEL}（0円としては扱いません）
        </label>
        <label className="u1-choice">
          <input type="radio" name="u3-budget" checked={b.budgetMode === 'amount'} onChange={() => setBase('budgetMode', 'amount')} />
          金額を指定する
        </label>
        {b.budgetMode === 'amount' && (
          <div className="u1-row2">
            <div className="u1-field">
              <label htmlFor="u3-amount">金額</label>
              <input id="u3-amount" type="text" inputMode="decimal" value={b.budgetAmount} placeholder="例: 30000" aria-invalid={Boolean(shown.budget)}
                onChange={e => setBase('budgetAmount', e.target.value)} />
            </div>
            <div className="u1-field">
              <label htmlFor="u3-cur">通貨</label>
              <select id="u3-cur" value={b.budgetCurrency} onChange={e => setBase('budgetCurrency', e.target.value)}>
                {BUDGET_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
        )}
        {budgetPreview && <p className="meta">送信する予算: {budgetPreview}（{b.budgetCurrency}のみ。他通貨へ換算しません）</p>}
        {shown.budget && <p className="u1-fielderr">{shown.budget}</p>}
      </fieldset>

      <div className="u1-row2">
        <div className="u1-field">
          <label htmlFor="u3-dep">出発条件（任意）</label>
          <input id="u3-dep" type="text" value={form.departureLabel} placeholder="例: 金沢駅 9時頃" onChange={e => onChange({ ...form, departureLabel: e.target.value })} />
          {shown.departure && <p className="u1-fielderr">{shown.departure}</p>}
        </div>
        <div className="u1-field">
          <label htmlFor="u3-ret">帰着条件（任意）</label>
          <input id="u3-ret" type="text" value={form.returnLabel} placeholder="例: 金沢駅 18時まで" onChange={e => onChange({ ...form, returnLabel: e.target.value })} />
          {shown.return && <p className="u1-fielderr">{shown.return}</p>}
        </div>
      </div>
      <p className="meta">出発・帰着は文字のまま送ります（地点IDや時刻は推測で補いません）。</p>

      <fieldset className="u1-field u1-fieldset">
        <legend>食事と散策（任意）</legend>
        <label className="u1-choice">
          <input type="checkbox" checked={form.meal} onChange={e => onChange({ ...form, meal: e.target.checked })} />
          固定の店舗での食事を含める
        </label>
        <label className="u1-choice">
          <input type="checkbox" checked={form.freeWalk} onChange={e => onChange({ ...form, freeWalk: e.target.checked })} />
          店舗を決めないエリア散策・食べ歩きを含める
        </label>
        {shown.preferences && <p className="u1-fielderr">{shown.preferences}</p>}
      </fieldset>

      <section aria-label="必須地点の選択" className="u1-fieldset" style={{ padding: 8 }}>
        <h2 className="u1-sub">必須地点（任意・最大{MAX_MUST_VISIT}件）</h2>
        <div className="u1-field">
          <label htmlFor="u3-search">地点を探す地域</label>
          <input id="u3-search" type="search" value={props.searchArea} placeholder={b.area || '例: 金沢'} onChange={e => props.onSearchAreaChange(e.target.value)} />
        </div>
        <div className="u1-actions">
          <button type="button" className="btn" disabled={!searchReady || search.status === 'loading'} onClick={props.onSearch}>
            {search.status === 'loading' ? '検索中…' : '候補地点を検索'}
          </button>
        </div>
        {!searchReady && <p className="meta">検索には地域と基本の交通手段が必要です。</p>}
        {search.status === 'error' && <ErrorBox title="地点を取得できませんでした" error={search.error} onRetry={props.onSearch} />}
        {search.status === 'done' && (
          <>
            <p className="meta">
              {search.source === 'mock' ? 'モック' : '実API'}・データ: {search.dataMode}
              {search.unknown.length > 0 ? ` / 取得できなかった項目: ${search.unknown.join('、')}` : ''}
            </p>
            {search.places.length === 0 ? (
              <p className="u1-empty">この地域の候補地点は見つかりませんでした（候補を作り足すことはしません）。</p>
            ) : (
              <ul className="u1-cards" aria-label="検索結果">
                {search.places.map(p => (
                  <PlaceCard key={p.placeId} place={p} tripZone={zone} selected={selectedIds.has(p.placeId)} disabled={form.selected.length >= MAX_MUST_VISIT}
                    onToggle={() => onChange(selectedIds.has(p.placeId) ? removeMustVisit(form, p.placeId) : addMustVisit(form, p))} />
                ))}
              </ul>
            )}
          </>
        )}
        <h3 className="u1-dayhead">選択済み（{form.selected.length}件）</h3>
        {form.selected.length === 0 ? (
          <p className="meta">まだ選択していません。</p>
        ) : (
          <ul aria-label="選択済みの必須地点">
            {form.selected.map(p => (
              <li key={p.placeId}>
                {p.name}（{KIND_LABEL[p.kind]}） <PlaceSourceBadge place={p} />{' '}
                <button type="button" className="btn" onClick={() => onChange(removeMustVisit(form, p.placeId))}>外す</button>
              </li>
            ))}
          </ul>
        )}
        {shown.selected && <p className="u1-fielderr">{shown.selected}</p>}
        <div className="u1-field">
          <label htmlFor="u3-must-text">検索で見つからない地点（任意・1行に1件）</label>
          <textarea id="u3-must-text" rows={2} value={b.mustVisit} onChange={e => setBase('mustVisit', e.target.value)} aria-describedby="u3-must-note" />
          <p id="u3-must-note" className="meta">ここに書いた地点は地点IDが未解決の「希望条件」として送ります（必須地点としては確定しません）。</p>
          {shown.mustVisit && <p className="u1-fielderr">{shown.mustVisit}</p>}
        </div>
      </section>

      {result.warnings.length > 0 && (
        <ul className="meta" aria-label="注意">
          {result.warnings.map(w => <li key={w}>{w}</li>)}
        </ul>
      )}

      {submitError && <ErrorBox title="生成を開始できませんでした" error={submitError} />}
      {accepted && (
        <div role="status" className="u1-ok">
          <strong>生成を受け付けました</strong>
          <p>ジョブID: <code>{accepted.jobId}</code>（状態: {accepted.state}、{accepted.pollAfterMs}ms後に確認）</p>
        </div>
      )}

      {/* Next to the submit button, so what is still missing is seen where it is pressed (UI review on #33). */}
      <div className="u1-checklist" role="group" aria-label="必須項目の入力状況">
        <strong>必須項目</strong>
        <ul>
          {REQUIRED_FIELDS.map(k => (
            <li key={k} className={result.missing.includes(k) ? 'u1-miss' : 'u1-done'}>
              {result.missing.includes(k) ? '未入力' : '入力済み'}：{CONDITIONS_LABEL[k]}
            </li>
          ))}
        </ul>
      </div>

      <div className="u1-actions">
        <button type="submit" className="btn u1-primary" disabled={busy || aiUnavailable || accepted !== null}>
          {busy ? '送信中…' : aiUnavailable ? '候補を生成する（現在利用不可）' : '候補を生成する'}
        </button>
        <button type="button" className="btn" onClick={() => onChange(sampleConditions)}>サンプルを入力</button>
        <button type="button" className="btn" onClick={() => onChange(defaultConditions)}>クリア</button>
      </div>
      <p className="meta">送信前の要求内容は契約K01（GenerateRequest）で検証します。食事の希望: 「{MEAL_PREFERENCE}」、散策の希望: 「{FREE_WALK_PREFERENCE}」として送ります。</p>
    </form>
  );
}

/** Scrolls to the first field showing an error and puts the cursor in its input (or the error summary if none). */
export function focusFirstError(root: HTMLElement | null) {
  const err = root?.querySelector('.u1-fielderr');
  const field = err?.closest('.u1-field') ?? root?.querySelector<HTMLElement>('.u1-error');
  if (!field) return;
  const target = field.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea') ?? (field as HTMLElement);
  field.scrollIntoView?.({ block: 'center' });
  target.focus?.({ preventScroll: true });
}

/** Stateful U03 screen. onStarted hands the accepted job to the next screen (U05 progress). */
export function ConditionsScreen({ api, onStarted, initialForm = defaultConditions, now }: {
  api: ConditionsApi;
  onStarted?: (accepted: JobAccepted, request: GenerateRequest) => void;
  initialForm?: ConditionsForm;
  now?: Date;
}) {
  const [form, setForm] = useState(initialForm);
  const [searchArea, setSearchArea] = useState('');
  const [search, setSearch] = useState<SearchState>({ status: 'idle' });
  const [capability, setCapability] = useState<CapabilityState>({ status: 'loading' });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const [submitError, setSubmitError] = useState<ErrorInfo | null>(null);
  const [accepted, setAccepted] = useState<JobAccepted | null>(null);
  const keyFor = useRef<{ body: string; key: string } | null>(null);
  const searchCtl = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    void api.capabilities().then(r => {
      if (!live) return;
      setCapability(r.ok ? { status: 'done', data: r.data } : { status: 'error', error: toErrorInfo(r) });
    });
    return () => {
      live = false;
      mounted.current = false;
      searchCtl.current?.abort();
    };
  }, [api]);

  const runSearch = async () => {
    const area = (searchArea.trim() || form.base.area).trim();
    const mode = form.base.transportMode;
    if (!area || mode === '') return;
    searchCtl.current?.abort();
    const ctl = new AbortController();
    searchCtl.current = ctl;
    setSearch({ status: 'loading' });
    const zone = form.base.timeZone.trim();
    const tzOk = TimeZone.safeParse(zone).success;
    const r = await api.planningContext({ area, transportMode: mode, maxPlaces: 15, ...(tzOk ? { timeZone: zone } : {}) }, ctl.signal);
    if (ctl.signal.aborted || !mounted.current) return;
    setSearch(r.ok ? { status: 'done', places: r.data.places, unknown: r.data.unknown, dataMode: r.data.dataMode, source: r.source } : { status: 'error', error: toErrorInfo(r) });
  };

  const submit = async () => {
    setSubmitted(true);
    setSubmitError(null);
    const { request } = buildConditionsRequest(form, now);
    if (!request) {
      // Go back to the first field with an error (UI review on #33); the errors render on this same click.
      requestAnimationFrame(() => focusFirstError(sectionRef.current));
      return;
    }
    if (capability.status === 'done' && !capability.data.aiGeneration.available) return;
    const body = JSON.stringify(request);
    // Same body -> same Idempotency-Key, so a retry after a network error never starts a second job.
    if (keyFor.current?.body !== body) keyFor.current = { body, key: newIdempotencyKey() };
    setBusy(true);
    let r: ApiResult<JobAccepted>;
    try {
      r = await api.generate(request, keyFor.current.key);
    } catch (e) {
      r = { ok: false, source: api.source, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : 'error', retryable: true, requestId: 'client' } };
    }
    if (!mounted.current) return;
    setBusy(false);
    if (r.ok) {
      setAccepted(r.data);
      onStarted?.(r.data, request);
    } else setSubmitError(toErrorInfo(r));
  };

  return (
    <section aria-label="条件入力" ref={sectionRef}>
      <ScreenHeader title="旅の条件を入力" />
      <ConditionsView form={form} onChange={f => { setForm(f); setAccepted(null); }} onSubmit={() => void submit()}
        onSearch={() => void runSearch()} searchArea={searchArea} onSearchAreaChange={setSearchArea} search={search}
        capability={capability} submitted={submitted} busy={busy} submitError={submitError} accepted={accepted} source={api.source}
        {...(now ? { now } : {})} />
    </section>
  );
}
