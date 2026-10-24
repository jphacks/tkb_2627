#!/usr/bin/env node
// D01: records what Google Maps Platform returns for a few places and routes, and what it does not.
// Default: prints the planned requests only (no network, no key needed).
// `--live`: sends the planned requests ONCE each, sequentially, never more than MAX_CALLS, no retries.
// The key is read from the environment or the repo .env and is never printed. Responses are not stored:
// only metadata (status, counts, which requested fields came back) is printed, for docs/provider-probe.md.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = process.argv.includes('--live');
/** Hard cap for one run. Changing it needs M1's approval (Issue #11). */
const MAX_CALLS = 20;
const TIMEOUT_MS = 15_000;

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// Coordinates from the B04 fixtures (approximate, illustrative).
const KANAZAWA_STATION = { latitude: 36.578, longitude: 136.648 };
const KENROKUEN = { latitude: 36.562, longitude: 136.662 };
const LOUVRE = { latitude: 48.861, longitude: 2.336 };
const ORSAY = { latitude: 48.86, longitude: 2.326 };

/** Tomorrow at a local wall time given as a UTC hour (10:00 JST = 01Z, 10:00 CET = 09Z). Transit allows up to 100 days ahead. */
function tomorrowAtUtcHour(hour) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString().replace('.000Z', 'Z');
}

const place = (label, textQuery, languageCode, regionCode, fieldMask, sku) => ({
  label,
  api: 'Places API (New) Text Search',
  sku,
  url: PLACES_URL,
  fieldMask,
  body: { textQuery, languageCode, regionCode, pageSize: 1 },
});
const route = (label, origin, destination, travelMode, fieldMask, sku, extra = {}) => ({
  label,
  api: 'Routes API computeRoutes',
  sku,
  url: ROUTES_URL,
  fieldMask,
  body: { origin: { location: { latLng: origin } }, destination: { location: { latLng: destination } }, travelMode, languageCode: 'ja', units: 'METRIC', ...extra },
});

const PLACE_PRO = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.attributions'];
const TRANSIT_FIELDS = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.transitDetails',
  'routes.travelAdvisory.transitFare',
];

export const PLAN = [
  place('kanazawa-place', '兼六園', 'ja', 'JP', PLACE_PRO, 'Text Search Pro'),
  place('kanazawa-hours', '兼六園', 'ja', 'JP', [...PLACE_PRO, 'places.regularOpeningHours'], 'Text Search Enterprise'),
  place('paris-place', 'Musée du Louvre', 'ja', 'FR', PLACE_PRO, 'Text Search Pro'),
  route('kanazawa-drive', KANAZAWA_STATION, KENROKUEN, 'DRIVE', ['routes.duration', 'routes.distanceMeters'], 'Compute Routes Essentials'),
  route('kanazawa-transit', KANAZAWA_STATION, KENROKUEN, 'TRANSIT', TRANSIT_FIELDS, 'Compute Routes (transit; tier per pricing page)', {
    departureTime: tomorrowAtUtcHour(1),
  }),
  route('paris-drive', LOUVRE, ORSAY, 'DRIVE', ['routes.duration', 'routes.distanceMeters'], 'Compute Routes Essentials'),
  route('paris-transit', LOUVRE, ORSAY, 'TRANSIT', TRANSIT_FIELDS, 'Compute Routes (transit; tier per pricing page)', {
    departureTime: tomorrowAtUtcHour(9),
  }),
];

if (PLAN.length > MAX_CALLS) throw new Error(`plan has ${PLAN.length} calls, over the cap of ${MAX_CALLS}`);

/** GOOGLE_MAPS_SERVER_KEY from the environment, else from the repo .env (simple KEY=VALUE lines). */
function serverKey() {
  if (process.env.GOOGLE_MAPS_SERVER_KEY) return process.env.GOOGLE_MAPS_SERVER_KEY;
  const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
  if (!existsSync(envFile)) return '';
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find(l => l.startsWith('GOOGLE_MAPS_SERVER_KEY='));
  return line ? line.slice('GOOGLE_MAPS_SERVER_KEY='.length).trim() : '';
}

/** Whether a dotted field path (e.g. routes.legs.steps.transitDetails) has a value anywhere in the response. */
function present(obj, path) {
  const [head, ...rest] = path.split('.');
  if (obj === null || obj === undefined) return false;
  if (Array.isArray(obj)) return obj.some(o => present(o, path));
  if (!(head in obj)) return false;
  return rest.length === 0 ? obj[head] !== null && obj[head] !== undefined : present(obj[head], rest.join('.'));
}

async function call(req, key) {
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': req.fieldMask.join(',') },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    const items = json?.places ?? json?.routes ?? [];
    return {
      label: req.label,
      fetchedAt,
      httpStatus: res.status,
      errorStatus: json?.error?.status ?? null,
      errorMessage: json?.error?.message?.slice(0, 200) ?? null,
      resultCount: Array.isArray(items) ? items.length : 0,
      returnedFields: req.fieldMask.filter(f => present(json, f)),
      missingFields: req.fieldMask.filter(f => !present(json, f)),
    };
  } catch (e) {
    return { label: req.label, fetchedAt, httpStatus: null, errorStatus: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', resultCount: 0 };
  } finally {
    clearTimeout(timer);
  }
}

const plan = PLAN.map(({ label, api, sku, fieldMask, body }) => ({ label, api, sku, fieldMask, body }));
if (!LIVE) {
  console.log(JSON.stringify({ mode: 'dry-run', calls: PLAN.length, maxCalls: MAX_CALLS, plan }, null, 2));
  process.exit(0);
}

const key = serverKey();
if (!key) {
  console.error('GOOGLE_MAPS_SERVER_KEY is not set (environment or .env). D01 stays blocked.');
  process.exit(2);
}
const results = [];
for (const req of PLAN.slice(0, MAX_CALLS)) results.push(await call(req, key));
console.log(JSON.stringify({ mode: 'live', calls: results.length, maxCalls: MAX_CALLS, results }, null, 2));
