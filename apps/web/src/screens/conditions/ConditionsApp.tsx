import { useMemo, useState } from 'react';
import type { GenerateRequest, JobAccepted } from '@tkb/contracts';
import { MockBanner } from '../../components/MockBanner.tsx';
import { ScenarioSwitcher } from '../../components/ScenarioSwitcher.tsx';
import { createMockApi, type MockScenario } from '../../mocks/index.ts';
import { createLiveConditionsApi, createMockConditionsApi, type DataSource } from './api.ts';
import { ConditionsScreen } from './ConditionsScreen.tsx';
import '../../components/u01.css';

/**
 * U03 standalone entry (#conditions). Mock mode uses the U01 in-memory mock; live mode calls the personal app
 * server (/local) and the shared server (/api) through the vite proxy. The accepted job is handed to
 * `onStarted` (U05 progress plugs in here); without it the job id is shown on the screen.
 */
export function ConditionsApp({ initialSource = 'mock', onStarted }: {
  initialSource?: DataSource;
  onStarted?: (accepted: JobAccepted, request: GenerateRequest) => void;
}) {
  const [source, setSource] = useState<DataSource>(initialSource);
  const [scenario, setScenario] = useState<MockScenario>('normal');
  const [aiAvailable, setAiAvailable] = useState(true);
  const api = useMemo(
    () => (source === 'live' ? createLiveConditionsApi() : createMockConditionsApi(createMockApi({ scenario }), scenario, { aiAvailable })),
    [source, scenario, aiAvailable],
  );
  return (
    <div className="u1-root">
      {source === 'mock' ? (
        <MockBanner />
      ) : (
        <div role="status" className="u1-banner" style={{ background: 'var(--accbg)' }}>
          <span className="u1-banner-tag" style={{ background: 'var(--acc)' }}>LIVE</span>
          <span>実APIに接続しています（本人用App Server・共有サーバー）。送信すると本人の生成ジョブが作られます。</span>
        </div>
      )}
      <div className="u1-scenario">
        <label htmlFor="u3-source">接続先（レビュー用）</label>
        <select id="u3-source" value={source} onChange={e => setSource(e.target.value as DataSource)}>
          <option value="mock">モック（mock）</option>
          <option value="live">実API（live）</option>
        </select>
      </div>
      {source === 'mock' && (
        <>
          <ScenarioSwitcher value={scenario} onChange={setScenario} />
          <label className="u1-choice" style={{ padding: '0 12px' }}>
            <input type="checkbox" checked={!aiAvailable} onChange={e => setAiAvailable(!e.target.checked)} />
            AI生成を利用不可にする（capabilities.aiGeneration.available=false の確認用）
          </label>
        </>
      )}
      <main className="u1-main">
        <ConditionsScreen key={`${source}:${scenario}:${aiAvailable}`} api={api} {...(onStarted ? { onStarted } : {})} />
      </main>
    </div>
  );
}
