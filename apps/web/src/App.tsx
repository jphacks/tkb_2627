import { useEffect, useState } from 'react';
import { FIXTURE_NOTICE, fixtureTrips } from '@tkb/fixtures';
import { ConditionsApp } from './screens/conditions/ConditionsApp.tsx';
import { ItineraryScreen } from './screens/itinerary/ItineraryScreen.tsx';
import { parseItineraryHash } from './screens/itinerary/route.ts';
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
  const [hash, setHash] = useState(() => (typeof location !== 'undefined' ? location.hash : ''));
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // U04: #/trips/<id>/map (server) or #/mock/trips/<id>/map (mock). Reload refetches the trip by id.
  const itinerary = parseItineraryHash(hash);
  if (itinerary) return <ItineraryScreen key={`${itinerary.mode}:${itinerary.tripId}`} route={itinerary} onBack={() => { location.hash = ''; }} />;
  // The U01 screens are the default (M1, #9). The skeleton stays reachable for development only.
  if (hash === '#dev-shell') return <DevShell />;
  // U03 condition input (mock / live switch). Joins the U01 flow once U05 progress is wired (#31).
  if (hash === '#conditions') return <ConditionsApp />;
  return <U01App />;
}
