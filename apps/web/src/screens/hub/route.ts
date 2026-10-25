/** Hub routes: empty hash and #home open the hub; #u01 keeps the mock-only U01 prototype. */
export type HubRoute = 'home' | 'u01';

export function parseHubHash(hash: string): HubRoute | null {
  if (hash === '' || hash === '#' || hash === '#home' || hash === '#/home') return 'home';
  if (hash === '#u01') return 'u01';
  return null;
}

/** Hashes of the real screens for one trip (server mode). */
export function tripLinks(tripId: string) {
  const base = `#/trips/${encodeURIComponent(tripId)}`;
  return [
    { key: 'map', label: '地図', href: `${base}/map` },
    { key: 'edit', label: '編集', href: `${base}/edit` },
    { key: 'guide', label: 'ガイド', href: `${base}/guide` },
  ] as const;
}
