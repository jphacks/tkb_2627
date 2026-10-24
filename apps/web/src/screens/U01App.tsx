import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { MockBanner } from '../components/MockBanner.tsx';
import { ScenarioSwitcher } from '../components/ScenarioSwitcher.tsx';
import { TabBar } from '../components/TabBar.tsx';
import { createMockApi, type MockScenario } from '../mocks/index.ts';
import { CandidateCompare } from './CandidateCompare.tsx';
import { ConditionInput } from './ConditionInput.tsx';
import { emptyForm } from './condition.ts';
import { flowReducer, initialFlow, type FlowState } from './flow.ts';
import { GenerationProgress } from './GenerationProgress.tsx';
import { Guide } from './Guide.tsx';
import { Feed, Share } from './Share.tsx';
import { TripDetailEdit } from './TripDetailEdit.tsx';
import { TripList } from './TripList.tsx';
import '../components/u01.css';

/** How often the mock job is polled (the mock's default of 2s makes the slow scenario tedious). */
const MOCK_POLL_AFTER_MS = 700;

/**
 * U01 root: mock banner + scenario switcher on top, one screen in the middle, tab bar at the bottom.
 * Data comes only from the in-memory mock API; nothing is sent over the network or stored in the browser.
 */
export function U01App({ initialScenario = 'normal' }: { initialScenario?: MockScenario }) {
  const [scenario, setScenario] = useState<MockScenario>(initialScenario);
  return (
    <div className="u1-root">
      <MockBanner />
      <ScenarioSwitcher value={scenario} onChange={setScenario} />
      {/* A new key recreates the mock API and resets the screen state. */}
      <Shell key={scenario} scenario={scenario} />
    </div>
  );
}

function Shell({ scenario }: { scenario: MockScenario }) {
  const api = useMemo(() => createMockApi({ scenario, pollAfterMs: MOCK_POLL_AFTER_MS }), [scenario]);
  const [flow, dispatch] = useReducer(flowReducer, initialFlow);
  const [form, setForm] = useState(emptyForm);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the new screen so keyboard and screen-reader users start at its top.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
    window.scrollTo(0, 0);
  }, [flow.screen.name]);

  return (
    <>
      <main className="u1-main" ref={main} tabIndex={-1} aria-label="画面">
        <Screen api={api} flow={flow} dispatch={dispatch} form={form} setForm={setForm} />
      </main>
      <TabBar active={flow.tab} onSelect={tab => dispatch({ type: 'selectTab', tab })} />
    </>
  );
}

function Screen({ api, flow, dispatch, form, setForm }: {
  api: ReturnType<typeof createMockApi>;
  flow: FlowState;
  dispatch: (action: Parameters<typeof flowReducer>[1]) => void;
  form: typeof emptyForm;
  setForm: (f: typeof emptyForm) => void;
}) {
  const s = flow.screen;
  const back = () => dispatch({ type: 'back' });
  switch (s.name) {
    case 'tripList':
      return <TripList api={api} onOpen={tripId => dispatch({ type: 'openTrip', tripId })} onCreate={() => dispatch({ type: 'selectTab', tab: 'new' })} />;
    case 'condition':
      return (
        <ConditionInput api={api} form={form} onFormChange={setForm}
          onStarted={a => dispatch({ type: 'generationStarted', jobId: a.jobId, pollAfterMs: a.pollAfterMs })} />
      );
    case 'progress':
      return (
        <GenerationProgress key={s.jobId} api={api} jobId={s.jobId} pollAfterMs={s.pollAfterMs} onBack={back}
          onSucceeded={batchId => dispatch({ type: 'generationSucceeded', batchId })} />
      );
    case 'compare':
      return <CandidateCompare api={api} batchId={s.batchId} onBack={back} onApplied={tripId => dispatch({ type: 'candidateApplied', tripId })} />;
    case 'detail':
      return (
        <TripDetailEdit api={api} tripId={s.tripId} onBack={back}
          onGuide={() => dispatch({ type: 'openGuide', tripId: s.tripId })}
          onShare={() => dispatch({ type: 'openShare', tripId: s.tripId })} />
      );
    case 'guide':
      return <Guide api={api} tripId={s.tripId} onBack={back} />;
    case 'share':
      return <Share api={api} tripId={s.tripId} onBack={back} />;
    case 'feed':
      return <Feed api={api} />;
  }
}
