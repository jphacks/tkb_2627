/** E01 hash routes: #/trips/<id>/print (server) and #/mock/trips/<id>/print (mock, no network). */
export interface PrintRoute {
  mode: 'server' | 'mock';
  tripId: string;
}

const ROUTE = /^#\/(mock\/)?trips\/([A-Za-z0-9_-]{1,128})\/print$/;

export function parsePrintHash(hash: string): PrintRoute | null {
  const m = ROUTE.exec(hash);
  if (!m || !m[2]) return null;
  return { mode: m[1] ? 'mock' : 'server', tripId: m[2] };
}
