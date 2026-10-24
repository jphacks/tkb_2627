import { useEffect, useState } from 'react';
import { FIXTURE_NOTICE, fixtureTrips } from '@tkb/fixtures';
import { ConditionsApp } from './screens/conditions/ConditionsApp.tsx';
import { GenerateApp } from './screens/generate/GenerateApp.tsx';
import { ItineraryScreen } from './screens/itinerary/ItineraryScreen.tsx';
import { parseItineraryHash } from './screens/itinerary/route.ts';
import { EditScreen } from './screens/edit/EditScreen.tsx';
import { parseTripScreenHash } from './screens/edit/route.ts';
import { GuideScreen } from './screens/guide/GuideScreen.tsx';
import { parseGuideHash } from './screens/guide/route.ts';
import { TravelScreen } from './screens/travel/TravelScreen.tsx';
import { U01App } from './screens/U01App.tsx';
import { SocialApp } from './screens/social/SocialApp.tsx';
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
  // U06: #/trips/<id>/edit and #/trips/<id>/travel (+ #/mock/... variants).
  const edit = parseTripScreenHash(hash, 'edit');
  if (edit) return <EditScreen key={`${edit.mode}:${edit.tripId}`} route={edit} />;
  const travel = parseTripScreenHash(hash, 'travel');
  if (travel) return <TravelScreen key={`${travel.mode}:${travel.tripId}`} route={travel} />;
  // U07: #/trips/<id>/guide (+ #/mock/...): current location and digital guide.
  const guide = parseGuideHash(hash);
  if (guide) return <GuideScreen key={`${guide.mode}:${guide.tripId}`} route={guide} />;
  // The U01 screens are the default (M1, #9). The skeleton stays reachable for development only.
  if (hash === '#dev-shell') return <DevShell />;
  // U03 condition input (mock / live switch). Joins the U01 flow once U05 progress is wired (#31).
  if (hash === '#conditions') return <ConditionsApp />;
  // U05 generation flow: conditions -> progress -> candidate compare -> apply -> U04 map (#33).
  if (hash === '#generate') return <GenerateApp />;
  // U08: SNS and group screens (#social), and the K17 invite link /invite#<token> (shared server).
  if (typeof location !== 'undefined' && location.pathname === '/invite') return <SocialApp initialMode="server" inviteToken={location.hash.slice(1) || null} />;
  if (hash === '#social') return <SocialApp />;
  return <U01App />;
}
