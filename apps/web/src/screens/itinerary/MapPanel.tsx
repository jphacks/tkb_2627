import { useEffect, useRef, useState } from 'react';
import type { MapPoint } from './model.ts';

/**
 * Map of the selected day. With a browser key it is a Google Map (Places results may only be drawn on a
 * Google Map, docs/provider-probe.md). Without a key, or when loading fails, a static numbered list is
 * shown instead ("地図キー未設定"); the attribution block below the map is shown in both cases.
 * Google is loaded only in the browser from useEffect, so tests (renderToString) never load it.
 */

// Minimal typing of the parts of the Maps JavaScript API used here (no @types/google.maps dependency).
interface LatLngLiteral { lat: number; lng: number }
interface GMarker { setMap(m: unknown): void; addListener(ev: string, fn: () => void): void; setIcon(i: unknown): void; setZIndex(z: number): void }
interface GMap { fitBounds(b: unknown, padding?: number): void; setCenter(c: LatLngLiteral): void; setZoom(z: number): void; panTo(c: LatLngLiteral): void }
interface GPolyline { setMap(m: unknown): void }
interface MapsLibs {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
  Polyline: new (opts: Record<string, unknown>) => GPolyline;
  Marker: new (opts: Record<string, unknown>) => GMarker;
  LatLngBounds: new () => { extend(p: LatLngLiteral): void };
}
interface GoogleMapsNs { importLibrary(name: string): Promise<Record<string, unknown>> }

const CALLBACK = '__tkbMapsReady';
let loading: Promise<MapsLibs> | null = null;

function loadMaps(key: string): Promise<MapsLibs> {
  if (loading) return loading;
  const w = window as unknown as Record<string, unknown> & { google?: { maps?: GoogleMapsNs } };
  const libs = async (): Promise<MapsLibs> => {
    const ns = w.google?.maps;
    if (!ns) throw new Error('Google Maps が初期化されていません');
    const [maps, marker, core] = await Promise.all([ns.importLibrary('maps'), ns.importLibrary('marker'), ns.importLibrary('core')]);
    return { Map: maps.Map, Polyline: maps.Polyline, Marker: marker.Marker, LatLngBounds: core.LatLngBounds } as MapsLibs;
  };
  loading = new Promise<MapsLibs>((resolve, reject) => {
    if (w.google?.maps) {
      libs().then(resolve, reject);
      return;
    }
    w[CALLBACK] = () => { libs().then(resolve, reject); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=ja&loading=async&callback=${CALLBACK}`;
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error('Google Maps を読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return loading;
}

const NORMAL_COLOR = '#2563eb';
const HIGHLIGHT_COLOR = '#d97706';
function icon(highlighted: boolean) {
  // SymbolPath.CIRCLE is 0. Highlight is bigger and a different colour (and the list shows it in text too).
  return { path: 0, scale: highlighted ? 15 : 11, fillColor: highlighted ? HIGHLIGHT_COLOR : NORMAL_COLOR, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2 };
}

export function MapPanel({ apiKey, points, highlighted, onSelectPlace }: {
  apiKey: string | null;
  points: MapPoint[];
  highlighted: ReadonlySet<string>;
  onSelectPlace: (placeId: string) => void;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!apiKey || failed) {
    return <StaticMap points={points} highlighted={highlighted} onSelectPlace={onSelectPlace}
      reason={apiKey ? `地図を表示できません（${failed}）` : '地図キー未設定'} />;
  }
  return <LiveMap apiKey={apiKey} points={points} highlighted={highlighted} onSelectPlace={onSelectPlace} onError={setFailed} />;
}

function LiveMap({ apiKey, points, highlighted, onSelectPlace, onError }: {
  apiKey: string;
  points: MapPoint[];
  highlighted: ReadonlySet<string>;
  onSelectPlace: (placeId: string) => void;
  onError: (msg: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [libs, setLibs] = useState<MapsLibs | null>(null);
  const map = useRef<GMap | null>(null);
  const markers = useRef(new Map<string, GMarker>());
  const select = useRef(onSelectPlace);
  select.current = onSelectPlace;

  useEffect(() => {
    let alive = true;
    loadMaps(apiKey).then(l => { if (alive) setLibs(l); }, (e: unknown) => { if (alive) onError(e instanceof Error ? e.message : '読み込み失敗'); });
    return () => { alive = false; };
  }, [apiKey, onError]);

  // (Re)draw markers and the visiting-order line when the day's points change.
  useEffect(() => {
    if (!libs || !el.current) return;
    if (!map.current) {
      map.current = new libs.Map(el.current, { center: points[0] ?? { lat: 35.68, lng: 139.76 }, zoom: 13, clickableIcons: false, gestureHandling: 'greedy', fullscreenControl: false, streetViewControl: false, mapTypeControl: false });
    }
    const m = map.current;
    const created = new Map<string, GMarker>();
    for (const p of points) {
      const mk = new libs.Marker({ map: m, position: { lat: p.lat, lng: p.lng }, label: { text: String(p.number), color: '#ffffff', fontWeight: '700' }, title: `${p.number}. ${p.name}`, icon: icon(false) });
      mk.addListener('click', () => select.current(p.placeId));
      created.set(p.placeId, mk);
    }
    markers.current = created;
    const line = points.length > 1
      ? new libs.Polyline({ map: m, path: points.map(p => ({ lat: p.lat, lng: p.lng })), strokeColor: NORMAL_COLOR, strokeOpacity: 0.6, strokeWeight: 3, geodesic: true })
      : null;
    if (points.length > 1) {
      const b = new libs.LatLngBounds();
      points.forEach(p => b.extend({ lat: p.lat, lng: p.lng }));
      m.fitBounds(b, 40);
    } else if (points[0]) {
      m.setCenter(points[0]);
      m.setZoom(15);
    }
    return () => {
      created.forEach(mk => mk.setMap(null));
      line?.setMap(null);
    };
  }, [libs, points]);

  // Selection sync: restyle markers and pan to the first highlighted one.
  useEffect(() => {
    let first: MapPoint | undefined;
    for (const p of points) {
      const on = highlighted.has(p.placeId);
      const mk = markers.current.get(p.placeId);
      mk?.setIcon(icon(on));
      mk?.setZIndex(on ? 1000 : p.number);
      if (on && !first) first = p;
    }
    if (first && map.current) map.current.panTo({ lat: first.lat, lng: first.lng });
  }, [libs, points, highlighted]);

  return (
    <div className="it-map">
      <div ref={el} className="it-map-canvas" role="application" aria-label="Google マップ（番号は行程表の地点番号）" />
      {!libs && <p className="u1-loading">地図を読み込み中…</p>}
      <PointList points={points} highlighted={highlighted} onSelectPlace={onSelectPlace} compact />
    </div>
  );
}

/** Fallback without Google: numbered places in visiting order. Selecting one syncs with the timeline. */
export function StaticMap({ points, highlighted, onSelectPlace, reason }: {
  points: MapPoint[];
  highlighted: ReadonlySet<string>;
  onSelectPlace: (placeId: string) => void;
  reason: string;
}) {
  return (
    <div className="it-map it-map-static" data-testid="map-fallback">
      <p className="it-map-reason"><strong>{reason}</strong>：地図の代わりに地点を訪問順に表示しています。</p>
      <PointList points={points} highlighted={highlighted} onSelectPlace={onSelectPlace} />
    </div>
  );
}

function PointList({ points, highlighted, onSelectPlace, compact = false }: {
  points: MapPoint[];
  highlighted: ReadonlySet<string>;
  onSelectPlace: (placeId: string) => void;
  compact?: boolean;
}) {
  if (points.length === 0) return <p className="meta">この日は位置の分かる地点がありません。</p>;
  return (
    <ol className={`it-points${compact ? ' it-points-compact' : ''}`} aria-label="地図上の地点（訪問順）">
      {points.map(p => {
        const on = highlighted.has(p.placeId);
        return (
          <li key={p.placeId}>
            <button type="button" className={`it-point${on ? ' it-on' : ''}`} aria-pressed={on} onClick={() => onSelectPlace(p.placeId)}>
              <span className="it-num" aria-hidden="true">{p.number}</span>
              <span>{p.name}{on ? '（選択中）' : ''}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
