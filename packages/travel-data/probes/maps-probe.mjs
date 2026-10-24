#!/usr/bin/env node
// D01: records what Google Maps Platform returns for a few places and routes, and what it does not.
// Default: prints the planned requests only (no network, no key needed).
// `--live`: sends the planned requests ONCE each, sequentially, no retries, and stops at the first 429 / quota error.
// M1 approved 20 calls IN TOTAL (Issue #11). Calls are counted across runs: ALREADY_USED records committed runs and a
// git-ignored ledger (.local/provider-probe/calls.json) counts runs since; `--live` refuses to start over the total.
// The key is read from the environment or the repo .env and is never printed. Responses are not stored:
// only metadata (status, counts, which requested fields came back) is printed, for docs/provider-probe.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = process.argv.includes('--live');
/** `--only=a,b` runs just those labels (e.g. one extra check M1 approved) instead of the whole plan. */
const ONLY_ARG = process.argv.find(a => a === '--only' || a.startsWith('--only='));
const ONLY = ONLY_ARG === undefined ? null : [...new Set(ONLY_ARG.slice('--only='.length).split(',').filter(Boolean))];
/** Anything not understood stops the run: a typo must never widen it to the whole plan. */
const UNKNOWN_ARGS = process.argv.slice(2).filter(a => a !== '--live' && !a.startsWith('--only='));
/** Calls M1 approved for D01 in total. Raising it needs M1's approval (Issue #11). */
const APPROVED_TOTAL = 20;
/**
 * Calls already made by committed runs (see probes/results/). When committing a new run, add its calls here and
 * delete the local ledger, which counted the same calls until then.
 */
const ALREADY_USED = 12;
const TIMEOUT_MS = 15_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEDGER = join(ROOT, '.local', 'provider-probe', 'calls.json');

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// Coordinates from the B04 fixtures (approximate, illustrative).
const KANAZAWA_STATION = { latitude: 36.578, longitude: 136.648 };
const KENROKUEN = { latitude: 36.562, longitude: 136.662 };
const TOKYO_STATION = { latitude: 35.681, longitude: 139.767 };
const LOUVRE = { latitude: 48.861, longitude: 2.336 };
const ORSAY = { latitude: 48.86, longitude: 2.326 };

/** Tomorrow at a UTC hour (01Z = 10:00 JST; 09Z = 10:00 in Paris only in winter time, 11:00 in summer). Transit allows up to 100 days ahead. */
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
  // M1 approved one extra call (Issue #11): a long domestic segment, to tell "no transit in Japan" from "too short".
  route('kanazawa-tokyo-transit', KANAZAWA_STATION, TOKYO_STATION, 'TRANSIT', TRANSIT_FIELDS, 'Compute Routes (transit; tier per pricing page)', {
    departureTime: tomorrowAtUtcHour(1),
  }),
  route('paris-transit', LOUVRE, ORSAY, 'TRANSIT', TRANSIT_FIELDS, 'Compute Routes (transit; tier per pricing page)', {
    departureTime: tomorrowAtUtcHour(9),
  }),
];

/** Calls made by uncommitted runs on this machine. */
function ledgerCalls() {
  try {
    return Number(JSON.parse(readFileSync(LEDGER, 'utf8')).calls) || 0;
  } catch {
    return 0;
  }
}

/** GOOGLE_MAPS_SERVER_KEY from the environment, else the last non-empty one in the repo .env. */
function serverKey() {
  if (process.env.GOOGLE_MAPS_SERVER_KEY) return process.env.GOOGLE_MAPS_SERVER_KEY;
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return '';
  let key = '';
  for (const raw of readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?GOOGLE_MAPS_SERVER_KEY\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const value = m[1].replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, '').trim();
    if (value) key = value;
  }
  return key;
}

/** Whether a dotted field path (e.g. routes.legs.steps.transitDetails) has a non-empty value anywhere in the response. */
function present(obj, path) {
  if (Array.isArray(obj)) return obj.some(o => present(o, path));
  if (obj === null || typeof obj !== 'object') return false;
  const [head, ...rest] = path.split('.');
  if (!(head in obj)) return false;
  const value = obj[head];
  if (rest.length > 0) return present(value, rest.join('.'));
  return value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0);
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
    // Never print e.message: Node can echo header values (the key) in fetch errors.
    return { label: req.label, fetchedAt, httpStatus: null, errorStatus: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', resultCount: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const used = ALREADY_USED + ledgerCalls();
  const remaining = APPROVED_TOTAL - used;
  if (UNKNOWN_ARGS.length > 0 || (ONLY !== null && ONLY.length === 0)) {
    const bad = [...new Set([...UNKNOWN_ARGS, ...(ONLY?.length === 0 ? [ONLY_ARG] : [])])];
    console.error(`Unknown or empty arguments: ${bad.join(' ')}. Use --only=label[,label] and/or --live.`);
    return 2;
  }
  const selected = ONLY ? PLAN.filter(r => ONLY.includes(r.label)) : PLAN;
  if (ONLY && selected.length !== ONLY.length) {
    console.error(`Unknown label in --only: ${ONLY.filter(l => !PLAN.some(r => r.label === l)).join(', ')}`);
    return 2;
  }
  const plan = selected.map(({ label, api, sku, fieldMask, body }) => ({ label, api, sku, fieldMask, body }));
  if (!LIVE) {
    console.log(JSON.stringify({ mode: 'dry-run', calls: selected.length, approvedTotal: APPROVED_TOTAL, used, remaining, plan }, null, 2));
    return 0;
  }
  if (selected.length > remaining) {
    console.error(`Refused: ${selected.length} calls planned but only ${remaining} of the ${APPROVED_TOTAL} approved remain. Ask M1 (Issue #11).`);
    return 3;
  }
  const key = serverKey();
  if (!key) {
    console.error('GOOGLE_MAPS_SERVER_KEY is not set (environment or .env). D01 stays blocked.');
    return 2;
  }
  // Count the calls before sending them, so a crash cannot hide spent calls.
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify({ calls: ledgerCalls() + selected.length, updatedAt: new Date().toISOString() }) + '\n');
  const results = [];
  for (const req of selected) {
    const r = await call(req, key);
    results.push(r);
    // A quota/budget error means the limit worked: record it and stop (M1: no retries).
    if (r.httpStatus === 429 || r.errorStatus === 'RESOURCE_EXHAUSTED') break;
  }
  console.log(JSON.stringify({ mode: 'live', calls: results.length, approvedTotal: APPROVED_TOTAL, usedBefore: used, results }, null, 2));
  return 0;
}

// Run only when executed directly, so importing PLAN does not exit the importer.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
