/** #/trips/<id>/guide (real) and #/mock/trips/<id>/guide (mock): the U07 current-location and digital guide screen. */
export interface GuideRoute { mode: 'server' | 'mock'; tripId: string }

const ROUTE = /^#\/(mock\/)?trips\/([A-Za-z0-9_-]{1,128})\/guide$/;

export function parseGuideHash(hash: string): GuideRoute | null {
  const m = ROUTE.exec(hash);
  if (!m || !m[2]) return null;
  return { mode: m[1] ? 'mock' : 'server', tripId: m[2] };
}

export const guideHash = (r: GuideRoute): string => `#/${r.mode === 'mock' ? 'mock/' : ''}trips/${encodeURIComponent(r.tripId)}/guide`;
