import { FIXTURE_NOTICE, fixtureTrips } from '@tkb/fixtures';
import { ConnectionChips } from './shell/ConnectionChips.tsx';
import { TripViewer } from './shell/TripViewer.tsx';

export function App() {
  return (
    <>
      <div role="status" className="fixture-banner"><strong>FIXTURE</strong> {FIXTURE_NOTICE}</div>
      <main className="app">
        <h1>旅行プラン（骨格）</h1>
        <ConnectionChips />
        <TripViewer trips={fixtureTrips} />
      </main>
    </>
  );
}
