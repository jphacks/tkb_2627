import { useEffect, useRef, useState } from 'react';
import type { TransportMode } from '@tkb/contracts';
import { ErrorBox, type ErrorInfo } from '../components/ErrorBox.tsx';
import { ScreenHeader } from '../components/ScreenHeader.tsx';
import type { MockApi } from '../mocks/index.ts';
import type { JobAccepted } from '@tkb/contracts';
import {
  CURRENCIES,
  FIELD_LABEL,
  REQUIRED_FIELDS,
  TIME_ZONE_SUGGESTIONS,
  emptyForm,
  sampleForm,
  validateCondition,
  type ConditionForm,
  type FieldKey,
} from './condition.ts';

/** aria-describedby must only point at elements that exist. */
const describedBy = (...ids: (string | false | undefined)[]): string | undefined => {
  const list = ids.filter(Boolean).join(' ');
  return list === '' ? undefined : list;
};

function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  return message ? <p id={id} className="u1-fielderr">{message}</p> : null;
}

/** Presentational form: shows the required-field checklist and (after a submit attempt) the errors. */
export function ConditionFormView({ form, onChange, onSubmit, submitted, busy, submitError, focusToken = 0 }: {
  form: ConditionForm;
  onChange: (next: ConditionForm) => void;
  onSubmit: () => void;
  submitted: boolean;
  busy: boolean;
  submitError: ErrorInfo | null;
  /** Changes after every failed submit attempt; the error summary then receives focus. */
  focusToken?: number;
}) {
  const { errors, missing } = validateCondition(form);
  const shown = submitted ? errors : {};
  const set = <K extends keyof ConditionForm>(key: K, value: ConditionForm[K]) => onChange({ ...form, [key]: value });
  const errorKeys = Object.keys(shown) as FieldKey[];
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusToken > 0) summary.current?.focus();
  }, [focusToken]);

  return (
    <form className="u1-form" noValidate onSubmit={e => { e.preventDefault(); onSubmit(); }}>
      <div className="u1-checklist" role="group" aria-label="必須項目の入力状況">
        <strong>必須項目</strong>
        <ul>
          {REQUIRED_FIELDS.map(k => (
            <li key={k} className={missing.includes(k) ? 'u1-miss' : 'u1-done'}>
              {missing.includes(k) ? '未入力' : '入力済み'}：{FIELD_LABEL[k]}
            </li>
          ))}
        </ul>
      </div>

      {errorKeys.length > 0 && (
        <div role="alert" className="u1-error" tabIndex={-1} ref={summary}>
          <strong>入力内容を確認してください（{errorKeys.length}件）</strong>
          <ul>{errorKeys.map(k => <li key={k}>{FIELD_LABEL[k]}: {shown[k]}</li>)}</ul>
        </div>
      )}

      <div className="u1-field">
        <label htmlFor="c-area">地域（必須）</label>
        <input id="c-area" type="text" value={form.area} placeholder="例: 金沢" autoComplete="off"
          aria-invalid={Boolean(shown.area)} aria-describedby={describedBy(shown.area && 'c-area-err')}
          onChange={e => set('area', e.target.value)} />
        <FieldError id="c-area-err" message={shown.area} />
      </div>

      <div className="u1-row2">
        <div className="u1-field">
          <label htmlFor="c-start">開始日（必須）</label>
          <input id="c-start" type="date" value={form.startDate} aria-invalid={Boolean(shown.startDate)}
            aria-describedby={describedBy(shown.startDate && 'c-start-err')} onChange={e => set('startDate', e.target.value)} />
          <FieldError id="c-start-err" message={shown.startDate} />
        </div>
        <div className="u1-field">
          <label htmlFor="c-end">終了日（必須）</label>
          <input id="c-end" type="date" value={form.endDate} min={form.startDate || undefined}
            aria-invalid={Boolean(shown.endDate)} aria-describedby={describedBy(shown.endDate && 'c-end-err')}
            onChange={e => set('endDate', e.target.value)} />
          <FieldError id="c-end-err" message={shown.endDate} />
        </div>
      </div>

      <div className="u1-field">
        <label htmlFor="c-tz">タイムゾーン（IANA名・必須）</label>
        <input id="c-tz" type="text" list="c-tz-list" value={form.timeZone} autoComplete="off" placeholder="例: Asia/Tokyo"
          aria-invalid={Boolean(shown.timeZone)} aria-describedby={describedBy(shown.timeZone && 'c-tz-err')}
          onChange={e => set('timeZone', e.target.value)} />
        <datalist id="c-tz-list">
          {TIME_ZONE_SUGGESTIONS.map(z => <option key={z} value={z} />)}
        </datalist>
        <FieldError id="c-tz-err" message={shown.timeZone} />
      </div>

      <fieldset className="u1-field u1-fieldset" aria-describedby={describedBy(shown.transportMode && 'c-mode-err')}>
        <legend>交通手段（必須）</legend>
        {(['transit', 'car'] as TransportMode[]).map(m => (
          <label key={m} className="u1-choice">
            <input type="radio" name="c-mode" value={m} checked={form.transportMode === m}
              onChange={() => set('transportMode', m)} />
            {m === 'transit' ? '公共交通' : '車'}
          </label>
        ))}
        <FieldError id="c-mode-err" message={shown.transportMode} />
      </fieldset>

      <fieldset className="u1-field u1-fieldset" aria-describedby={describedBy(shown.budget && 'c-budget-err')}>
        <legend>予算（任意）</legend>
        <label className="u1-choice">
          <input type="radio" name="c-budget" checked={form.budgetMode === 'unknown'} onChange={() => set('budgetMode', 'unknown')} />
          予算を決めていない（予算なしで候補を作る。0円としては扱いません）
        </label>
        <label className="u1-choice">
          <input type="radio" name="c-budget" checked={form.budgetMode === 'amount'} onChange={() => set('budgetMode', 'amount')} />
          金額を指定する
        </label>
        {form.budgetMode === 'amount' && (
          <div className="u1-row2">
            <div className="u1-field">
              <label htmlFor="c-amount">金額</label>
              <input id="c-amount" type="text" inputMode="decimal" value={form.budgetAmount} placeholder="例: 30000"
                aria-invalid={Boolean(shown.budget)} aria-describedby={describedBy(shown.budget && 'c-budget-err')}
                onChange={e => set('budgetAmount', e.target.value)} />
            </div>
            <div className="u1-field">
              <label htmlFor="c-cur">通貨</label>
              <select id="c-cur" value={form.budgetCurrency} onChange={e => set('budgetCurrency', e.target.value)}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
        )}
        <FieldError id="c-budget-err" message={shown.budget} />
      </fieldset>

      <div className="u1-field">
        <label htmlFor="c-must">必須地点（任意・1行に1件）</label>
        <textarea id="c-must" rows={3} value={form.mustVisit} placeholder={'例:\n兼六園\n近江町市場'}
          aria-invalid={Boolean(shown.mustVisit)} aria-describedby={describedBy('c-must-note', shown.mustVisit && 'c-must-err')}
          onChange={e => set('mustVisit', e.target.value)} />
        <p id="c-must-note" className="meta">
          入力した地点名は、地点IDが未解決の「希望条件」（preferences）として送ります。地点の選択（地点IDへの解決）は未接続のため、必須地点（mustVisit）としては確定されません。
        </p>
        <FieldError id="c-must-err" message={shown.mustVisit} />
      </div>

      {submitError && <ErrorBox title="生成を開始できませんでした" error={submitError} />}

      <div className="u1-actions">
        <button type="submit" className="btn u1-primary" disabled={busy}>{busy ? '送信中…' : '候補を生成する'}</button>
        <button type="button" className="btn" onClick={() => onChange(sampleForm)}>サンプルを入力</button>
        <button type="button" className="btn" onClick={() => onChange(emptyForm)}>クリア</button>
      </div>
      <p className="meta">モックでは入力内容に関わらず金沢のサンプル候補が返ります。</p>
    </form>
  );
}

export function ConditionInput({ api, form, onFormChange, onStarted }: {
  api: MockApi;
  form: ConditionForm;
  onFormChange: (next: ConditionForm) => void;
  onStarted: (accepted: JobAccepted) => void;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorInfo | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  // False once the screen is left (tab switch): local state is no longer updated. StrictMode's simulated remount sets it back to true.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async () => {
    setSubmitted(true);
    setSubmitError(null);
    const { request } = validateCondition(form);
    if (!request) {
      setFocusToken(n => n + 1);
      return;
    }
    setBusy(true);
    try {
      const result = await api.generate(request);
      // An accepted job is always handed to the flow, even if the user already left this screen: it keeps
      // running in the background and is found again from the 新規作成 tab (R28). Only local state is guarded.
      if (result.ok) onStarted(result.data);
      else if (mounted.current) setSubmitError(result.error);
    } catch (e) {
      if (!mounted.current) return;
      setSubmitError({ message: e instanceof Error ? e.message : '予期しないエラーが発生しました。', code: 'INTERNAL' });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section aria-label="条件入力">
      <ScreenHeader title="旅の条件を入力" />
      <ConditionFormView form={form} onChange={onFormChange} onSubmit={() => void submit()} submitted={submitted} busy={busy} submitError={submitError} focusToken={focusToken} />
    </section>
  );
}
