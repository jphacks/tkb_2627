import { useEffect, useState } from 'react';
import { FIXTURE_NOTICE, fixtureTrips } from '@tkb/fixtures';
import { U01App } from './screens/U01App.tsx';
import { ConnectionChips } from './shell/ConnectionChips.tsx';
import { TripViewer } from './shell/TripViewer.tsx';

const DEV_SHELL_HASH = '#dev-shell';

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

const isDevShell = () => typeof location !== 'undefined' && location.hash === DEV_SHELL_HASH;

export function App() {
  // The U01 screens are the default (M1, #9). The skeleton stays reachable for development only.
  const [devShell, setDevShell] = useState(isDevShell);
  useEffect(() => {
    const onHashChange = () => setDevShell(isDevShell());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return devShell ? <DevShell /> : <U01App />;
}
