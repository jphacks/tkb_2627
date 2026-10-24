import { useState } from 'react';
import type { ApiError, PlanBatch, PlanCandidate, ValidationState } from '@tkb/contracts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { MoneyTotals } from '../components/MoneyText.tsx';
import { ScreenHeader } from '../components/ScreenHeader.tsx';
import { SourceBadge } from '../components/SourceBadge.tsx';
import { UNKNOWN_LABEL, VALIDATION_LABEL } from '../components/labels.ts';
import { thrownToError, useMockResult, type AsyncResult } from '../components/useMockResult.ts';
import { formatDay } from '../lib/format.ts';
import type { MockApi, MockResult } from '../mocks/index.ts';

/** The main API refuses to apply these states (422), so the UI does not offer 採用. */
const NOT_ADOPTABLE: readonly ValidationState[] = ['invalid', 'needs_revalidation'];

function countActivities(c: PlanCandidate): number {
  return c.days.reduce((n, d) => n + d.items.filter(i => i.type === 'activity').length, 0);
}

export function CandidateCard({ candidate, index, busy, onAdopt }: {
  candidate: PlanCandidate;
  index: number;
  busy: boolean;
  onAdopt: (candidateId: string) => void;
}) {
  const blocked = NOT_ADOPTABLE.includes(candidate.validationState);
  const first = candidate.days[0];
  const last = candidate.days[candidate.days.length - 1];
  return (
    <article className="u1-cand" aria-labelledby={`cand-${candidate.candidateId}`}>
      <p className="meta">候補 {index + 1}</p>
      <h2 id={`cand-${candidate.candidateId}`} className="u1-cand-title">{candidate.title}</h2>
      <p>
        <span className={`u1-state u1-state-${candidate.validationState}`}>{VALIDATION_LABEL[candidate.validationState]}</span>
      </p>
      {first && last && (
        <p className="meta">{formatDay(first.date)} - {formatDay(last.date)}（{candidate.days.length}日 / 予定 {countActivities(candidate)}件）</p>
      )}

      <p className="u1-costline">
        既知の費用: <strong><MoneyTotals totals={candidate.totalKnownCost} /></strong>
      </p>
      {candidate.hasUnknownCost && (
        <p className="meta">費用が{UNKNOWN_LABEL}の項目を含みます。上の金額には含まれておらず、0円ではありません。</p>
      )}

      {candidate.warnings.length > 0 && (
        <div className="note" aria-label="警告">
          <strong>警告</strong>
          <ul>{candidate.warnings.map(w => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      {candidate.reasons.length > 0 && (
        <details className="u1-details">
          <summary>この候補の理由（{candidate.reasons.length}件）</summary>
          <ul>{candidate.reasons.map(r => <li key={r}>{r}</li>)}</ul>
        </details>
      )}

      <button type="button" className="btn u1-primary" disabled={busy || blocked} onClick={() => onAdopt(candidate.candidateId)}>
        {blocked ? '採用できません' : busy ? '処理中…' : 'この候補を採用'}
      </button>
      {blocked && <p className="meta">状態が「{VALIDATION_LABEL[candidate.validationState]}」の候補は採用できません。</p>}
    </article>
  );
}

/** Presentational: up to 3 candidates side by side (horizontal scroll at phone width). */
export function CompareView({ state, busyId, applyError, onAdopt, onRetry }: {
  state: AsyncResult<PlanBatch>;
  busyId: string | null;
  applyError: ApiError | null;
  onAdopt: (candidateId: string) => void;
  onRetry: () => void;
}) {
  if (state.status === 'loading') return <p role="status" className="u1-loading">候補を読み込み中…</p>;
  const result: MockResult<PlanBatch> = state.result;
  if (!result.ok) return <ErrorBox title="候補を読み込めませんでした" error={result.error} onRetry={onRetry} />;
  const candidates = result.data.candidates.slice(0, 3);
  return (
    <>
      {candidates.length === 0 ? (
        <div className="u1-empty"><p>候補がありません。条件を変えてもう一度お試しください。</p></div>
      ) : (
        <>
          <p className="meta">横にスクロールして候補を比較できます（{candidates.length}件）。</p>
          <div className="u1-scroller" role="group" aria-label="候補の比較" tabIndex={0}>
            {candidates.map((c, i) => (
              <CandidateCard key={c.candidateId} candidate={c} index={i} busy={busyId !== null} onAdopt={onAdopt} />
            ))}
          </div>
        </>
      )}
      {applyError && <ErrorBox title="採用できませんでした" error={applyError} />}
      <p className="u1-srcline"><SourceBadge result={result} /></p>
    </>
  );
}

export function CandidateCompare({ api, batchId, onApplied, onBack }: {
  api: MockApi;
  batchId: string;
  onApplied: (tripId: string) => void;
  onBack: () => void;
}) {
  const [state, reload] = useMockResult(() => api.getPlanBatch(batchId), batchId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<ApiError | null>(null);

  const adopt = async (candidateId: string) => {
    setBusyId(candidateId);
    setApplyError(null);
    try {
      const r = await api.applyCandidate({ batchId, candidateId, tripId: null, expectedRevision: null });
      if (r.ok) onApplied(r.data.tripId);
      else setApplyError(r.error);
    } catch (e) {
      setApplyError(thrownToError(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="候補の比較">
      <ScreenHeader title="候補を比較" onBack={onBack} />
      <CompareView state={state} busyId={busyId} applyError={applyError} onAdopt={id => void adopt(id)} onRetry={reload} />
    </section>
  );
}
