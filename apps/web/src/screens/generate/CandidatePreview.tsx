import { useMemo, useState } from 'react';
import type { PlanBatch, PlanCandidate, TripConstraints, Trip } from '@tkb/contracts';
import { ItineraryView } from '../itinerary/ItineraryScreen.tsx';
import { readBrowserMapsKey } from '../itinerary/mapsKey.ts';
import '../itinerary/itinerary.css';

/**
 * The candidate as an unsaved Trip, so the U04 table and map can show it. Nothing is invented: days, places, warnings and
 * the validation state are the candidate's own; ids and timestamps are placeholders that never reach the server.
 */
export function candidateAsTrip(batch: PlanBatch, candidate: PlanCandidate, constraints: TripConstraints): Trip {
  return {
    schemaVersion: 1,
    tripId: `preview_${batch.batchId}_${candidate.candidateId}`.slice(0, 120),
    ownerId: 'preview',
    title: candidate.title || '候補の旅程',
    revision: 1,
    constraints,
    days: structuredClone(candidate.days),
    places: structuredClone(batch.places),
    validationState: candidate.validationState,
    warnings: [...candidate.warnings],
    createdAt: batch.createdAt,
    updatedAt: batch.createdAt,
  };
}

/**
 * U04 under U03 (#generate): after the plan is generated, the itinerary table and map of a candidate (the first one at the
 * start) are shown directly below the condition form, so the user can look at the result, change the conditions and
 * generate again without leaving the page. Reordering here only changes the preview; adopting a candidate saves it (K08).
 */
export function CandidatePreview({ batch, constraints, mapsKey = readBrowserMapsKey() }: {
  batch: PlanBatch;
  constraints: TripConstraints;
  mapsKey?: string | null;
}) {
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const candidates = batch.candidates.slice(0, 3);
  const current = candidates.find(c => c.candidateId === candidateId) ?? candidates[0];
  const trip = useMemo(() => (current ? candidateAsTrip(batch, current, constraints) : null), [batch, current, constraints]);

  if (!current || !trip) return null;
  return (
    <section aria-label="生成された旅程（地図と行程表）" className="u5-preview">
      <h2 className="u1-cand-title">生成された旅程：地図と行程表</h2>
      {candidates.length > 1 && (
        <div className="it-days" role="tablist" aria-label="表示する候補">
          {candidates.map((c, i) => (
            <button key={c.candidateId} type="button" role="tab" aria-selected={c.candidateId === current.candidateId}
              className={`it-day${c.candidateId === current.candidateId ? ' it-on' : ''}`}
              onClick={() => { setCandidateId(c.candidateId); setDayIndex(0); }}>
              候補{i + 1}：{c.title}
            </button>
          ))}
        </div>
      )}
      <ItineraryView key={trip.tripId} trip={trip} source="preview" previewNote="候補の表示（まだ保存していません。「この候補を採用」で保存します）"
        dayIndex={dayIndex} onSelectDay={setDayIndex} mapsKey={mapsKey} editor={{ kind: 'local' }} hideHeader />
    </section>
  );
}
