/**
 * Hash routes of the edit (U06) and travel (U06) screens:
 *   #/trips/<id>/edit   #/trips/<id>/travel          real mode (K09/K10 through the vite proxy)
 *   #/mock/trips/<id>/edit  #/mock/trips/<id>/travel  mock mode (in-memory mock, no network)
 */
export type TripScreenKind = 'edit' | 'travel' | 'map';
export interface TripScreenRoute { mode: 'server' | 'mock'; tripId: string }

const re = (kind: TripScreenKind) => new RegExp(`^#/(mock/)?trips/([A-Za-z0-9_-]{1,128})/${kind}$`);

export function parseTripScreenHash(hash: string, kind: 'edit' | 'travel'): TripScreenRoute | null {
  const m = re(kind).exec(hash);
  if (!m || !m[2]) return null;
  return { mode: m[1] ? 'mock' : 'server', tripId: m[2] };
}

export function tripScreenHash(route: TripScreenRoute, kind: TripScreenKind): string {
  return `#/${route.mode === 'mock' ? 'mock/' : ''}trips/${encodeURIComponent(route.tripId)}/${kind}`;
}
