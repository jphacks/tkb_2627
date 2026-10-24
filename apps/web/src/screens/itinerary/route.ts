/**
 * Hash routes of the itinerary screen, so a reload re-opens the same trip and fetches it again:
 *   #/trips/<tripId>/map       real mode (K09 GET /api/v1/trips/<tripId> through the vite proxy)
 *   #/mock/trips/<tripId>/map  mock mode (in-memory U01 mock API, no network)
 * Optional `?day=<n>` keeps the selected day tab (0-based).
 */
export interface ItineraryRoute {
  mode: 'server' | 'mock';
  tripId: string;
  dayIndex: number;
}

const ROUTE = /^#\/(mock\/)?trips\/([A-Za-z0-9_-]{1,128})\/map(?:\?day=(\d{1,3}))?$/;

export function parseItineraryHash(hash: string): ItineraryRoute | null {
  const m = ROUTE.exec(hash);
  if (!m || !m[2]) return null;
  return { mode: m[1] ? 'mock' : 'server', tripId: m[2], dayIndex: m[3] ? Number(m[3]) : 0 };
}

export function itineraryHash(route: ItineraryRoute): string {
  const base = `#/${route.mode === 'mock' ? 'mock/' : ''}trips/${encodeURIComponent(route.tripId)}/map`;
  return route.dayIndex > 0 ? `${base}?day=${route.dayIndex}` : base;
}
