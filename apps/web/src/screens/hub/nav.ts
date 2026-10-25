import { parseHubHash } from './route.ts';
import { screenFor } from './screenBadge.ts';

export type TripTabKey = 'map' | 'edit' | 'guide' | 'print';
export interface NavTab { key: TripTabKey; label: string; href: string; current: boolean }
export interface NavModel {
  /** false on the home screen: no bar there. */
  visible: boolean;
  title: string | null;
  tabs: NavTab[];
}

const TABS: ReadonlyArray<{ key: TripTabKey; label: string }> = [

  { key: 'edit', label: '地図・編集' },
  { key: 'guide', label: 'ガイド' },
];

const TRIP_RE = /^#\/(mock\/)?trips\/([^/?]+)\/(map|edit|guide|print)(?:[?/].*)?$/;

/** Tab row for a trip hash, keeping mock/server mode and trip id. Empty for non-trip hashes. */
export function tripTabs(hash: string): NavTab[] {
  const m = TRIP_RE.exec(hash);
  if (!m) return [];
  const [, mock, id, cur] = m;
  const base = `#/${mock ? 'mock/' : ''}trips/${id}`;
  // U11: 地図 and 編集 are one tab; /map opens the same screen, so it marks that tab too.
  return TABS.map((t) => ({ ...t, href: `${base}/${t.key}`, current: t.key === cur || (t.key === 'edit' && cur === 'map') }));
}

export function navModel(hash: string, pathname = '/'): NavModel {
  if (pathname !== '/invite' && parseHubHash(hash) === 'home') return { visible: false, title: null, tabs: [] };
  const tabs = tripTabs(hash);
  return { visible: true, title: tabs.length === 0 ? screenFor(hash, pathname).name : null, tabs };
}

/** Back goes to the previous in-app page when there is one, otherwise to #home. */
export function backTarget(appDepth: number): 'history' | '#home' {
  return appDepth > 0 ? 'history' : '#home';
}

/** Depth bookkeeping from history.state: a state with a depth is a pop (restore), none is a new push (+1). */
export function nextDepth(prev: number, stateDepth: unknown): number {
  return typeof stateDepth === 'number' ? stateDepth : prev + 1;
}
