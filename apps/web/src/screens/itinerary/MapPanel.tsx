import { useEffect, useRef, useState } from 'react';
import type { MapPoint } from './model.ts';

/**
 * Map of the selected day: numbered points joined by arrowed lines in visiting order (R5: points on the map, no list;
 * the direction of travel is visible). With a browser key it is a Google Map (Places results may only be drawn on a
 * Google Map, docs/provider-probe.md). Without a key, or when loading fails, a schematic SVG map with the same points
 * and arrows is drawn instead ("地図キー未設定"); the attribution block below the map is shown in both cases.
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
    s.onerror = () => { loading = null; s.remove(); reject(new Error('Google Maps を読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Optional extra markers (e.g. U07 amenities: toilets, evacuation sites). Not numbered and not part of the route line.
 * `shape` + `glyph` + `color` make kinds distinguishable without relying on colour alone.
 */
export interface ExtraMarker {
  id: string;
  lat: number;
  lng: number;
  title: string;
  shape: 'square' | 'triangle' | 'diamond';
  glyph: string;
  color: string;
}
const SHAPE_PATH: Record<ExtraMarker['shape'], string> = {
  square: 'M-8,-8 L8,-8 L8,8 L-8,8 z',
  triangle: 'M0,-10 L10,8 L-10,8 z',
  diamond: 'M0,-11 L11,0 L0,11 L-11,0 z',
};
function extraIcon(m: ExtraMarker, selected: boolean) {
  return { path: SHAPE_PATH[m.shape], scale: selected ? 1.4 : 1, fillColor: m.color, fillOpacity: 1, strokeColor: selected ? '#111827' : '#ffffff', strokeWeight: 2 };
}

const NORMAL_COLOR = '#2563eb';
const HIGHLIGHT_COLOR = '#d97706';
function icon(highlighted: boolean) {
  // SymbolPath.CIRCLE is 0. Highlight is bigger and a different colour (and the list shows it in text too).
  return { path: 0, scale: highlighted ? 15 : 11, fillColor: highlighted ? HIGHLIGHT_COLOR : NORMAL_COLOR, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2 };
}

/**
 * Origins on which the browser key may be used. Mirrors the HTTP-referrer restriction of PUBLIC_MAPS_BROWSER_KEY
 * (http://127.0.0.1:5173/* and http://localhost:5173/*); on any other host/port Google answers RefererNotAllowedMapError,
 * so the schematic map is drawn instead. Update both together.
 */
export const MAPS_ALLOWED_ORIGINS: readonly string[] = ['http://127.0.0.1:5173', 'http://localhost:5173'];

export const ORIGIN_NOT_ALLOWED_REASON = 'このURLでは地図キーが使えないため、略図を表示しています（PCで http://127.0.0.1:5173/ を開くと地図が出ます）';

export type MapMode = { kind: 'google'; apiKey: string } | { kind: 'sketch'; reason: string };

/** Pure decision: Google only with a key, an allowed origin and no runtime failure; otherwise the sketch with the reason. */
export function chooseMapMode(apiKey: string | null, origin: string | null, failure: string | null): MapMode {
  if (!apiKey) return { kind: 'sketch', reason: '地図キー未設定' };
  if (origin === null || !MAPS_ALLOWED_ORIGINS.includes(origin)) return { kind: 'sketch', reason: ORIGIN_NOT_ALLOWED_REASON };
  if (failure) return { kind: 'sketch', reason: `地図を表示できないため、略図を表示しています（${failure}）` };
  return { kind: 'google', apiKey };
}

export function MapPanel({ apiKey, points, highlighted, onSelectPlace, extraMarkers, onSelectExtra, selectedExtraId }: {
  apiKey: string | null;
  points: MapPoint[];
  highlighted: ReadonlySet<string>;
  onSelectPlace: (placeId: string) => void;
  extraMarkers?: readonly ExtraMarker[];
  onSelectExtra?: (id: string) => void;
  selectedExtraId?: string | null;
}) {
  const extra = { ...(extraMarkers ? { extraMarkers } : {}), ...(onSelectExtra ? { onSelectExtra } : {}), selectedExtraId: selectedExtraId ?? null };
  const [failed, setFailed] = useState<string | null>(null);
  const mode = chooseMapMode(apiKey, typeof location !== 'undefined' ? location.origin : null, failed);
  if (mode.kind === 'sketch') return <StaticMap points={points} highlighted={highlighted} onSelectPlace={onSelectPlace} reason={mode.reason} {...extra} />;
  return <LiveMap apiKey={mode.apiKey} points={points} highlighted={highlighted} onSelectPlace={onSelectPlace} onError={setFailed} {...extra} />;
}

function LiveMap({ apiKey, points, highlighted, onSelectPlace, onError, extraMarkers, onSelectExtra, selectedExtraId }: {
  apiKey: string;
  points: MapPoint[];
  highlighted: ReadonlySet<string>;
  onSelectPlace: (placeId: string) => void;
  onError: (msg: string) => void;
  extraMarkers?: readonly ExtraMarker[];
  onSelectExtra?: (id: string) => void;
  selectedExtraId: string | null;
}) {
  const extraRefs = useRef(new Map<string, GMarker>());
  const selectExtra = useRef(onSelectExtra);
  selectExtra.current = onSelectExtra;
  const el = useRef<HTMLDivElement>(null);
  const [libs, setLibs] = useState<MapsLibs | null>(null);
  const map = useRef<GMap | null>(null);
  const markers = useRef(new Map<string, GMarker>());
  const select = useRef(onSelectPlace);
  select.current = onSelectPlace;

  useEffect(() => {
    let alive = true;
    // Google's documented auth-failure hook (bad key, referrer not allowed, ...): switch to the sketch instead of its grey error box.
    const w = window as unknown as Record<string, unknown>;
    const hook = () => { if (alive) onError('地図キーの認証に失敗'); };
    w.gm_authFailure = hook;
    loadMaps(apiKey).then(l => { if (alive) setLibs(l); }, (e: unknown) => { if (alive) onError(e instanceof Error ? e.message : '読み込み失敗'); });
    return () => { alive = false; if (w.gm_authFailure === hook) delete w.gm_authFailure; };
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
    // Direction of travel: a repeated forward arrow (SymbolPath.FORWARD_CLOSED_ARROW = 1) along the line.
    const line = points.length > 1
      ? new libs.Polyline({
        map: m, path: points.map(p => ({ lat: p.lat, lng: p.lng })), strokeColor: NORMAL_COLOR, strokeOpacity: 0.6, strokeWeight: 3, geodesic: true,
        icons: [{ icon: { path: 1, scale: 3, strokeColor: NORMAL_COLOR, fillColor: NORMAL_COLOR, fillOpacity: 1 }, offset: '50%', repeat: '90px' }],
      })
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

  // Extra markers (amenities): distinct shape, glyph and colour per kind; clicking shows their detail.
  useEffect(() => {
    if (!libs || !map.current || !extraMarkers) return undefined;
    const m = map.current;
    const created = new Map<string, GMarker>();
    for (const x of extraMarkers) {
      const mk = new libs.Marker({ map: m, position: { lat: x.lat, lng: x.lng }, label: { text: x.glyph, color: '#ffffff', fontWeight: '700', fontSize: '11px' }, title: x.title, icon: extraIcon(x, false), zIndex: 1 });
      mk.addListener('click', () => selectExtra.current?.(x.id));
      created.set(x.id, mk);
    }
    extraRefs.current = created;
    return () => { created.forEach(mk => mk.setMap(null)); };
  }, [libs, points, extraMarkers]);
  useEffect(() => {
    for (const x of extraMarkers ?? []) {
      const mk = extraRefs.current.get(x.id);
      mk?.setIcon(extraIcon(x, x.id === selectedExtraId));
      mk?.setZIndex(x.id === selectedExtraId ? 900 : 1);
    }
  }, [libs, points, extraMarkers, selectedExtraId]);

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
      {points.length === 0 && <p className="meta">この日は位置の分かる地点がありません。</p>}
    </div>
  );
}

export interface Projected { placeId: string; number: number; name: string; x: number; y: number }

export const MAP_W = 320;
export const MAP_H = 220;
const PAD = 30;

/** Equirectangular projection of the points into the SVG box (longitude scaled by cos(latitude)). Pure, tested. */
export function projectPoints(points: readonly MapPoint[], w = MAP_W, h = MAP_H, pad = PAD): Projected[] {
  if (points.length === 0) return [];
  const lats = points.map(p => p.lat);
  const lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = (maxLng - minLng) * k;
  const spanY = maxLat - minLat;
  const scale = Math.min(spanX > 0 ? (w - 2 * pad) / spanX : Infinity, spanY > 0 ? (h - 2 * pad) / spanY : Infinity);
  const s = Number.isFinite(scale) ? scale : 0;
  const offX = (w - spanX * s) / 2;
  const offY = (h - spanY * s) / 2;
  return points.map(p => ({
    placeId: p.placeId, number: p.number, name: p.name,
    x: Math.round((offX + (p.lng - minLng) * k * s) * 10) / 10,
    y: Math.round((h - (offY + (p.lat - minLat) * s)) * 10) / 10,
  }));
}

/** Arrowhead at the middle of each segment: position and angle in degrees (pointing from a to b). */
export function segmentArrows(pts: readonly Projected[]): { x: number; y: number; angle: number; from: number; to: number }[] {
  const out: { x: number; y: number; angle: number; from: number; to: number }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (a.x === b.x && a.y === b.y) continue;
    out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: Math.round(Math.atan2(b.y - a.y, b.x - a.x) * 1800 / Math.PI) / 10, from: a.number, to: b.number });
  }
  return out;
}

/**
 * Fallback without Google: the same numbered points and arrowed route drawn schematically (not a real map).
 * Points are clickable and keyboard operable; selecting one syncs with the itinerary table.
 */
export function StaticMap({ points, highlighted, onSelectPlace, reason, extraMarkers, onSelectExtra, selectedExtraId }: {
  points: MapPoint[];
  highlighted: ReadonlySet<string>;
  onSelectPlace: (placeId: string) => void;
  reason: string;
  extraMarkers?: readonly ExtraMarker[];
  onSelectExtra?: (id: string) => void;
  selectedExtraId?: string | null;
}) {
  // Extras are projected together with the points so they share one frame; without extras this is the plain projection.
  const extras = extraMarkers ?? [];
  const all = projectPoints([...points, ...extras.map((x, i): MapPoint => ({ placeId: x.id, number: -(i + 1), name: x.title, lat: x.lat, lng: x.lng }))]);
  const pts = all.slice(0, points.length);
  const extraPts = all.slice(points.length);
  const arrows = segmentArrows(pts);
  return (
    <div className="it-map it-map-static" data-testid="map-fallback">
      <p className="it-map-reason"><strong>{reason}</strong> 略図は地点と移動の向きだけを示し、実際の地形・経路ではありません。</p>
      {pts.length === 0 ? (
        <p className="meta">この日は位置の分かる地点がありません。</p>
      ) : (
        <svg className="it-svg" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="group" aria-label="地点と訪問順の略図（矢印は進む向き）">
          {pts.length > 1 && <polyline className="it-route" points={pts.map(p => `${p.x},${p.y}`).join(' ')} fill="none" />}
          {arrows.map(a => (
            <polygon key={`${a.from}-${a.to}`} className="it-arrow" data-testid="map-arrow" points="-6,-5 6,0 -6,5"
              transform={`translate(${a.x} ${a.y}) rotate(${a.angle})`}><title>{`${a.from} から ${a.to} へ`}</title></polygon>
          ))}
          {pts.map(p => {
            const on = highlighted.has(p.placeId);
            return (
              <g key={p.placeId} className={`it-node${on ? ' it-on' : ''}`} role="button" tabIndex={0} aria-pressed={on}
                aria-label={`${p.number}. ${p.name}${on ? '（選択中）' : ''}`}
                onClick={() => onSelectPlace(p.placeId)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectPlace(p.placeId); } }}>
                <circle cx={p.x} cy={p.y} r={on ? 14 : 11} />
                <text x={p.x} y={p.y + 4} textAnchor="middle" className="it-node-num">{p.number}</text>
                <text x={p.x} y={p.y - 17} textAnchor="middle" className="it-node-name">{p.name.length > 9 ? `${p.name.slice(0, 8)}…` : p.name}</text>
              </g>
            );
          })}
          {extras.map((x, i) => {
            const p = extraPts[i]!;
            const on = x.id === selectedExtraId;
            const k = on ? 1.35 : 1;
            return (
              <g key={x.id} className={`it-extra${on ? ' it-on' : ''}`} data-testid="extra-marker" data-extra-kind={x.glyph} role="button" tabIndex={0} aria-pressed={on}
                aria-label={`${x.title}${on ? '（選択中）' : ''}`}
                onClick={() => onSelectExtra?.(x.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectExtra?.(x.id); } }}>
                <path d={SHAPE_PATH[x.shape]} transform={`translate(${p.x} ${p.y}) scale(${k})`} fill={x.color} />
                <text x={p.x} y={p.y + 4} textAnchor="middle" className="it-node-num" style={{ fontSize: 10 }}>{x.glyph}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
