import { FIXTURE_NOTICE, fixtureTrips } from '@tkb/fixtures';
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
  // The U01 screens are the default (M1, #9). The skeleton stays reachable for development only.
  if (typeof location !== 'undefined' && location.hash === '#dev-shell') return <DevShell />;
  // U08: SNS and group screens (#social), and the K17 invite link /invite#<token> (shared server).
  if (typeof location !== 'undefined' && location.pathname === '/invite') return <SocialApp initialMode="server" inviteToken={location.hash.slice(1) || null} />;
  if (typeof location !== 'undefined' && location.hash === '#social') return <SocialApp />;
  return <U01App />;
}
