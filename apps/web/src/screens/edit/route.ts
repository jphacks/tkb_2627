/**
 * Hash routes of the edit (U06) screen (the travel screen was removed, UI review on #34):
 *   #/trips/<id>/edit       real mode (K09/K10 through the vite proxy)
 *   #/mock/trips/<id>/edit  mock mode (in-memory mock, no network)
 */
export type TripScreenKind = 'edit' | 'map';
export interface TripScreenRoute { mode: 'server' | 'mock'; tripId: string }

const re = (kind: TripScreenKind) => new RegExp(`^#/(mock/)?trips/([A-Za-z0-9_-]{1,128})/${kind}$`);

export function parseTripScreenHash(hash: string, kind: 'edit'): TripScreenRoute | null {
  const m = re(kind).exec(hash);
  if (!m || !m[2]) return null;
  return { mode: m[1] ? 'mock' : 'server', tripId: m[2] };
}

export function tripScreenHash(route: TripScreenRoute, kind: TripScreenKind): string {
  return `#/${route.mode === 'mock' ? 'mock/' : ''}trips/${encodeURIComponent(route.tripId)}/${kind}`;
}
