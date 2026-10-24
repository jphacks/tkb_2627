import { useState } from 'react';
import type { TransportMode } from '@tkb/contracts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { ScreenHeader } from '../components/ScreenHeader.tsx';
import { UNKNOWN_LABEL } from '../components/labels.ts';
import type { MockApi, MockResult } from '../mocks/index.ts';
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

function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  return message ? <p id={id} className="u1-fielderr">{message}</p> : null;
}

/** Presentational form: shows the required-field checklist and (after a submit attempt) the errors. */
export function ConditionFormView({ form, onChange, onSubmit, submitted, busy, submitError }: {
  form: ConditionForm;
  onChange: (next: ConditionForm) => void;
  onSubmit: () => void;
  submitted: boolean;
  busy: boolean;
  submitError: MockResult<JobAccepted> | null;
}) {
  const { errors, missing } = validateCondition(form);
  const shown = submitted ? errors : {};
  const set = <K extends keyof ConditionForm>(key: K, value: ConditionForm[K]) => onChange({ ...form, [key]: value });
  const errorKeys = Object.keys(shown) as FieldKey[];

  return (
    <form className="u1-form" noValidate onSubmit={e => { e.preventDefault(); onSubmit(); }}>
      <div className="u1-checklist" aria-label="必須項目の入力状況">
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
        <div role="alert" className="u1-error">
          <strong>入力内容を確認してください（{errorKeys.length}件）</strong>
          <ul>{errorKeys.map(k => <li key={k}>{FIELD_LABEL[k]}: {shown[k]}</li>)}</ul>
        </div>
      )}

      <div className="u1-field">
        <label htmlFor="c-area">地域（必須）</label>
        <input id="c-area" type="text" value={form.area} placeholder="例: 金沢" autoComplete="off"
          aria-invalid={Boolean(shown.area)} aria-describedby="c-area-err"
          onChange={e => set('area', e.target.value)} />
        <FieldError id="c-area-err" message={shown.area} />
      </div>

      <div className="u1-row2">
        <div className="u1-field">
          <label htmlFor="c-start">開始日（必須）</label>
          <input id="c-start" type="date" value={form.startDate} aria-invalid={Boolean(shown.startDate)}
            aria-describedby="c-start-err" onChange={e => set('startDate', e.target.value)} />
          <FieldError id="c-start-err" message={shown.startDate} />
        </div>
        <div className="u1-field">
          <label htmlFor="c-end">終了日（必須）</label>
          <input id="c-end" type="date" value={form.endDate} min={form.startDate || undefined}
            aria-invalid={Boolean(shown.endDate)} aria-describedby="c-end-err"
            onChange={e => set('endDate', e.target.value)} />
          <FieldError id="c-end-err" message={shown.endDate} />
        </div>
      </div>

      <div className="u1-field">
        <label htmlFor="c-tz">タイムゾーン（IANA名・必須）</label>
        <input id="c-tz" type="text" list="c-tz-list" value={form.timeZone} autoComplete="off"
          aria-invalid={Boolean(shown.timeZone)} aria-describedby="c-tz-err"
          onChange={e => set('timeZone', e.target.value)} />
        <datalist id="c-tz-list">
          {TIME_ZONE_SUGGESTIONS.map(z => <option key={z} value={z} />)}
        </datalist>
        <FieldError id="c-tz-err" message={shown.timeZone} />
      </div>

      <fieldset className="u1-field u1-fieldset" aria-describedby="c-mode-err">
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

      <fieldset className="u1-field u1-fieldset" aria-describedby="c-budget-err">
        <legend>予算（任意）</legend>
        <label className="u1-choice">
          <input type="radio" name="c-budget" checked={form.budgetMode === 'unknown'} onChange={() => set('budgetMode', 'unknown')} />
          {UNKNOWN_LABEL}（予算なしで候補を作る。0円としては扱いません）
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
                aria-invalid={Boolean(shown.budget)} onChange={e => set('budgetAmount', e.target.value)} />
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
          aria-invalid={Boolean(shown.mustVisit)} aria-describedby="c-must-note c-must-err"
          onChange={e => set('mustVisit', e.target.value)} />
        <p id="c-must-note" className="meta">
          地点ID形式（英数字・_・-）の入力は mustVisit として、名称は「希望条件」として送ります。名称から地点IDへの解決は未接続です。
        </p>
        <FieldError id="c-must-err" message={shown.mustVisit} />
      </div>

      {submitError && !submitError.ok && <ErrorBox title="生成を開始できませんでした" error={submitError.error} />}

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
  const [submitError, setSubmitError] = useState<MockResult<JobAccepted> | null>(null);

  const submit = async () => {
    setSubmitted(true);
    setSubmitError(null);
    const { request } = validateCondition(form);
    if (!request) return;
    setBusy(true);
    const result = await api.generate(request);
    setBusy(false);
    if (result.ok) onStarted(result.data);
    else setSubmitError(result);
  };

  return (
    <section aria-label="条件入力">
      <ScreenHeader title="旅の条件を入力" />
      <ConditionFormView form={form} onChange={onFormChange} onSubmit={() => void submit()} submitted={submitted} busy={busy} submitError={submitError} />
    </section>
  );
}
