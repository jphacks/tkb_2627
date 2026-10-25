import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenerateRequest, JobAccepted, PlanBatch } from '@tkb/contracts';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScenarioSwitcher } from '../../components/ScenarioSwitcher.tsx';
import { createMockApi, type MockScenario } from '../../mocks/index.ts';
import { createLiveConditionsApi, createMockConditionsApi, type DataSource } from '../conditions/api.ts';
import { ConditionsScreen } from '../conditions/ConditionsScreen.tsx';
import { itineraryHash } from '../itinerary/route.ts';
import { createLiveGenerateApi, createMockGenerateApi } from './api.ts';
import { CandidatePreview } from './CandidatePreview.tsx';
import { CompareScreen, LiveBanner, ModeChip, ProgressScreen } from './GenerateScreens.tsx';
import { openMap, revealStep, type ModeCapState } from './model.ts';
import '../../components/u01.css';

type Step =
  | { name: 'conditions' }
  | { name: 'progress'; accepted: JobAccepted; request: GenerateRequest }
  | { name: 'compare'; batchId: string; request: GenerateRequest };

/**
 * U05 flow (#generate): conditions (U03) stay on the page; below them progress (K02/K21) -> the U04 map + table of the
 * first candidate -> a short candidate compare (K07) -> apply (K08) -> U04 map link. Changing the conditions and generating again
 * replaces the result below without leaving the page.
 * Mock mode shares ONE in-memory mock API between the screens so the accepted job can be polled.
 */
export function GenerateApp({ initialSource = 'mock' }: { initialSource?: DataSource }) {
  const [source, setSource] = useState<DataSource>(initialSource);
  const [scenario, setScenario] = useState<MockScenario>('normal');
  const [step, setStep] = useState<Step>({ name: 'conditions' });
  const apis = useMemo(() => {
    if (source === 'live') return { cond: createLiveConditionsApi(), flow: createLiveGenerateApi() };
    const mock = createMockApi({ scenario });
    return { cond: createMockConditionsApi(mock, scenario), flow: createMockGenerateApi(mock) };
  }, [source, scenario]);
  const [modeCap, setModeCap] = useState<ModeCapState>({ status: 'loading' });
  useEffect(() => {
    if (source !== 'live') return undefined;
    let alive = true;
    setModeCap({ status: 'loading' });
    void apis.cond.capabilities().then(r => {
      if (!alive) return;
      setModeCap(r.ok ? { status: 'done', dataMode: r.data.dataMode, ai: { available: r.data.aiGeneration.available, reason: r.data.aiGeneration.reason } } : { status: 'error' });
    });
    return () => { alive = false; };
  }, [source, apis]);
  const [batch, setBatch] = useState<PlanBatch | null>(null);
  const reset = () => { setStep({ name: 'conditions' }); setBatch(null); };
  // Progress and compare open below the long conditions form, so bring them into view (UI review on #33).
  const stepRef = useRef<HTMLDivElement>(null);
  const stepKey = step.name === 'progress' ? step.accepted.jobId : step.name === 'compare' ? step.batchId : null;
  useEffect(() => {
    if (stepKey === null) return;
    revealStep(stepRef.current, window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  }, [stepKey]);

  return (
    <div className="u1-root">
      {source === 'mock' ? (
        <MockBanner />
      ) : (
        <LiveBanner state={modeCap} />
      )}
      <div className="u1-scenario">
        <label htmlFor="u5-source">接続先（レビュー用）</label>
        <select id="u5-source" value={source} onChange={e => { setSource(e.target.value as DataSource); reset(); }}>
          <option value="mock">モック（mock）</option>
          <option value="live">実API（live）</option>
        </select>
      </div>
      {source === 'mock' && <ScenarioSwitcher value={scenario} onChange={s => { setScenario(s); reset(); }} />}
      <main className="u1-main">
        <ConditionsScreen key={`${source}:${scenario}`} api={apis.cond} onStarted={(accepted, request) => { setBatch(null); setStep({ name: 'progress', accepted, request }); }} />
        <div ref={stepRef} tabIndex={-1} className="u5-step">
        {source === 'live' && step.name !== 'conditions' && <ModeChip state={modeCap} />}
        {step.name === 'progress' && (
          <ProgressScreen
            key={step.accepted.jobId} api={apis.flow} accepted={step.accepted} request={step.request}
            onSucceeded={batchId => setStep({ name: 'compare', batchId, request: step.request })}
            onRetried={accepted => setStep({ name: 'progress', accepted, request: step.request })}
            onBack={reset}
          />
        )}
        {step.name === 'compare' && (
          <>
            {/* The map comes first so it is in view right after generating; the short compare list follows (UI review on #33). */}
            {batch && batch.batchId === step.batchId && <CandidatePreview batch={batch} constraints={step.request.constraints} />}
            <CompareScreen
              key={step.batchId} api={apis.flow} batchId={step.batchId} onBack={reset} onBatchLoaded={setBatch}
              mapHrefFor={tripId => itineraryHash({ mode: source === 'mock' ? 'mock' : 'server', tripId, dayIndex: 0 })}
              onApplied={href => openMap(href, window)}
            />
          </>
        )}
        </div>
      </main>
    </div>
  );
}
