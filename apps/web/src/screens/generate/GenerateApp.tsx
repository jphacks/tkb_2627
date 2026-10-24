import { useMemo, useState } from 'react';
import type { GenerateRequest, JobAccepted } from '@tkb/contracts';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScenarioSwitcher } from '../../components/ScenarioSwitcher.tsx';
import { createMockApi, type MockScenario } from '../../mocks/index.ts';
import { createLiveConditionsApi, createMockConditionsApi, type DataSource } from '../conditions/api.ts';
import { ConditionsScreen } from '../conditions/ConditionsScreen.tsx';
import { itineraryHash } from '../itinerary/route.ts';
import { createLiveGenerateApi, createMockGenerateApi } from './api.ts';
import { CompareScreen, ProgressScreen } from './GenerateScreens.tsx';
import '../../components/u01.css';

type Step =
  | { name: 'conditions' }
  | { name: 'progress'; accepted: JobAccepted; request: GenerateRequest }
  | { name: 'compare'; batchId: string };

/**
 * U05 flow (#generate): conditions (U03) -> progress (K02/K21) -> candidate compare (K07) -> apply (K08) -> U04 map link.
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
  const reset = () => setStep({ name: 'conditions' });

  return (
    <div className="u1-root">
      {source === 'mock' ? (
        <MockBanner />
      ) : (
        <div role="status" className="u1-banner" style={{ background: 'var(--accbg)' }}>
          <span className="u1-banner-tag" style={{ background: 'var(--acc)' }}>LIVE</span>
          <span>実APIに接続しています。生成すると本人の生成ジョブが作られ、採用すると共有サーバーに旅程が保存されます。</span>
        </div>
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
        {step.name === 'conditions' && (
          <ConditionsScreen key={`${source}:${scenario}`} api={apis.cond} onStarted={(accepted, request) => setStep({ name: 'progress', accepted, request })} />
        )}
        {step.name === 'progress' && (
          <ProgressScreen
            key={step.accepted.jobId} api={apis.flow} accepted={step.accepted} request={step.request}
            onSucceeded={batchId => setStep({ name: 'compare', batchId })}
            onRetried={accepted => setStep({ name: 'progress', accepted, request: step.request })}
            onBack={reset}
          />
        )}
        {step.name === 'compare' && (
          <CompareScreen
            key={step.batchId} api={apis.flow} batchId={step.batchId} onBack={reset}
            mapHrefFor={tripId => itineraryHash({ mode: source === 'mock' ? 'mock' : 'server', tripId, dayIndex: 0 })}
          />
        )}
      </main>
    </div>
  );
}
