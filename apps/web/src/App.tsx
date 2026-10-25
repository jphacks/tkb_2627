import { useEffect, useState } from 'react';
import { FIXTURE_NOTICE, fixtureTrips } from '@tkb/fixtures';
import { ConditionsApp } from './screens/conditions/ConditionsApp.tsx';
import { GenerateApp } from './screens/generate/GenerateApp.tsx';
import { parseItineraryHash } from './screens/itinerary/route.ts';
import { PrintScreen } from './screens/print/PrintScreen.tsx';
import { parsePrintHash } from './screens/print/route.ts';
import { EditScreen } from './screens/edit/EditScreen.tsx';
import { parseTripScreenHash } from './screens/edit/route.ts';
import { GuideScreen } from './screens/guide/GuideScreen.tsx';
import { parseGuideHash } from './screens/guide/route.ts';
import { U01App } from './screens/U01App.tsx';
import { NavBar } from './screens/hub/NavBar.tsx';
import { ScreenBadge } from './screens/hub/ScreenBadge.tsx';
import { HomeApp } from './screens/hub/HomeApp.tsx';
import { parseHubHash } from './screens/hub/route.ts';
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
  return (
    <>
      <NavBar hash={hash} pathname={typeof location !== 'undefined' ? location.pathname : '/'} />
      <Screen hash={hash} />
      <ScreenBadge hash={hash} pathname={typeof location !== 'undefined' ? location.pathname : '/'} />
    </>
  );
}

function Screen({ hash }: { hash: string }) {
  // U04: #/trips/<id>/map (server) or #/mock/trips/<id>/map (mock). Reload refetches the trip by id.
  const itinerary = parseItineraryHash(hash);
  // U11: the map and the edit tab are one screen (map + editable itinerary), so /map and /edit both open it.
  if (itinerary) return <EditScreen key={`${itinerary.mode}:${itinerary.tripId}`} route={{ mode: itinerary.mode, tripId: itinerary.tripId }} />;
  // E01: #/trips/<id>/print (+ #/mock/... variant).
  const print = parsePrintHash(hash);
  if (print) return <PrintScreen key={`${print.mode}:${print.tripId}`} route={print} />;
  // U06: #/trips/<id>/edit (+ #/mock/... variant). The travel (旅行中) screen was removed (UI review on #34).
  const edit = parseTripScreenHash(hash, 'edit');
  if (edit) return <EditScreen key={`${edit.mode}:${edit.tripId}`} route={edit} />;
  // U07: #/trips/<id>/guide (+ #/mock/...): current location and digital guide.
  const guide = parseGuideHash(hash);
  if (guide) return <GuideScreen key={`${guide.mode}:${guide.tripId}`} route={guide} />;
  // The skeleton stays reachable for development only.
  if (hash === '#dev-shell') return <DevShell />;
  // U03 condition input (mock / live switch). Joins the U01 flow once U05 progress is wired (#31).
  if (hash === '#conditions') return <ConditionsApp />;
  // U05 generation flow: conditions -> progress -> candidate compare -> apply -> U04 map (#33).
  if (hash === '#generate') return <GenerateApp />;
  // U08: SNS and group screens (#social), and the K17 invite link /invite#<token> (shared server).
  if (typeof location !== 'undefined' && location.pathname === '/invite') return <SocialApp initialMode="server" inviteToken={location.hash.slice(1) || null} />;
  if (hash === '#social') return <SocialApp />;
  // Navigation hub: empty hash and #home. The mock-only U01 prototype stays at #u01.
  if (parseHubHash(hash) === 'u01') return <U01App />;
  return <HomeApp />;
}
