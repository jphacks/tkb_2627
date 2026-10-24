import type { MockScenario } from '../mocks/index.ts';
import { SCENARIOS, SCENARIO_LABEL } from './labels.ts';
import './u01.css';

/** Reviewer control: switching recreates the mock API (and resets the screen state). */
export function ScenarioSwitcher({ value, onChange }: { value: MockScenario; onChange: (s: MockScenario) => void }) {
  return (
    <div className="u1-scenario">
      <label htmlFor="u1-scenario-select">データシナリオ（レビュー用）</label>
      <select id="u1-scenario-select" value={value} onChange={e => onChange(e.target.value as MockScenario)}>
        {SCENARIOS.map(s => (
          <option key={s} value={s}>{SCENARIO_LABEL[s]}（{s}）</option>
        ))}
      </select>
    </div>
  );
}
