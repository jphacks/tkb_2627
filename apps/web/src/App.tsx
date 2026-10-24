import { FIXTURE_NOTICE, fixtureTrips } from '@tkb/fixtures';
import { ConditionsApp } from './screens/conditions/ConditionsApp.tsx';
import { U01App } from './screens/U01App.tsx';
import { ConnectionChips } from './shell/ConnectionChips.tsx';
import { TripViewer } from './shell/TripViewer.tsx';

/** Development view kept from the skeleton: connection chips and the fixture trip viewer. Open with #dev-shell. */
function DevShell() {
  return (
    <>
      <div role="status" className="fixture-banner"><strong>FIXTURE</strong> {FIXTURE_NOTICE}</div>
      <main className="app">
        <h1>旅行プラン（骨格・開発用）</h1>
        <ConnectionChips />
        <TripViewer trips={fixtureTrips} />
      </main>
    </>
  );
}

export function App() {
  // The U01 screens are the default (M1, #9). The skeleton stays reachable for development only.
  if (typeof location !== 'undefined' && location.hash === '#dev-shell') return <DevShell />;
  // U03 condition input (mock / live switch). Joins the U01 flow once U05 progress is wired (#31).
  if (typeof location !== 'undefined' && location.hash === '#conditions') return <ConditionsApp />;
  return <U01App />;
}
