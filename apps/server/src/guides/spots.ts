/**
 * K19 GET /api/v1/guides (spot descriptions + licensed photos, D07 sources).
 * Only placeIds the server itself knows (B04 fixture places) are ever looked up; the Wikipedia title is the known
 * place's own name, never request text, so there is no way to make the server fetch anything user-chosen.
 * (D07's WikipediaGuideSource also only builds https://<lang>.wikipedia.org and commons.wikimedia.org URLs, and the
 * photo URL must be on upload.wikimedia.org / thumb.wikimedia.org.)
 *
 * Status mapping:
 *  - bad placeId / lang                      -> 422
 *  - source failed (provider unavailable)    -> 503 UNAVAILABLE (retryable)
 *  - live lookups over the per-minute limit  -> 429 RATE_LIMITED
 *  - unknown place / no description          -> 200 items [] dataStatus "unknown" (explicit empty, not a failure)
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApiError, ERROR_HTTP_STATUS, GuideResponse, type ErrorCode, type PlaceInfo } from '@tkb/contracts';
import { kanazawaPlaces, parisPlaces } from '@tkb/fixtures';
import {
  CallBudget, FixtureGuideSource, PolicyError, WikipediaGuideSource, createUsageControls, guideResponse, usageLimitsFromEnv,
  type GuideResult, type GuideSource,
} from '@tkb/travel-data';

const LANGS = ['ja', 'en', 'fr'] as const;
type Lang = (typeof LANGS)[number];
const Query = z.object({
  placeId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  lang: z.enum(LANGS).default('ja'),
}).strict();
type GuideBody = z.infer<typeof GuideResponse>;

/** Strict allow-list: fixture spots/areas with a real-world name. Wikipedia title = name, in the place's own language. */
const KNOWN: ReadonlyMap<string, { place: PlaceInfo; lang: Lang }> = new Map(
  [...kanazawaPlaces, ...parisPlaces]
    .filter(p => (p.kind === 'spot' || p.kind === 'area') && !p.name.includes('fixture'))
    .map(p => [p.placeId, { place: p, lang: (p.timeZone === 'Europe/Paris' ? 'fr' : 'ja') as Lang }] as const),
);

export interface SpotGuideDeps {
  /** Tests inject a source. Otherwise: fixture source in fixture mode, Wikipedia source in other modes. */
  source?: GuideSource;
  live?: boolean;
  now?: () => number;
  /** Live lookups per minute per process (default 30). */
  liveLimitPerMinute?: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

function fail(reply: FastifyReply, reqId: string, code: ErrorCode, message: string, retryable = false) {
  return reply.status(ERROR_HTTP_STATUS[code]).header('cache-control', 'no-store').send(ApiError.parse({ code, message, retryable, requestId: reqId }));
}

export function registerSpotGuides(app: FastifyInstance, providerMode: string, deps: SpotGuideDeps = {}): void {
  const live = deps.live ?? providerMode !== 'fixture';
  const now = deps.now ?? Date.now;
  const limit = deps.liveLimitPerMinute ?? 30;
  const source: GuideSource = deps.source ?? (live ? new WikipediaGuideSource() : new FixtureGuideSource());
  const controls = createUsageControls(usageLimitsFromEnv());
  const cache = new Map<string, { at: number; body: GuideBody }>();
  let windowStart = 0;
  let windowCount = 0;
  const takeLive = (): boolean => {
    const t = now();
    if (t - windowStart >= 60_000) { windowStart = t; windowCount = 0; }
    if (windowCount >= limit) return false;
    windowCount += 1;
    return true;
  };

  app.get('/api/v1/guides', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const q = Query.safeParse(req.query);
    if (!q.success) return fail(reply, req.id, 'VALIDATION_FAILED', 'placeId と lang(ja|en|fr) を指定してください。');
    const { placeId, lang } = q.data;
    const known = KNOWN.get(placeId);
    const t = now();
    // Unknown place, or a language the place's title does not exist in: explicit "not found", no outbound call.
    if (!known || (live && known.lang !== lang)) {
      return GuideResponse.parse(guideResponse([{ item: null, reason: 'not_found', photoRejected: null }], t, live));
    }
    const key = `${placeId}|${lang}`;
    const hit = cache.get(key);
    if (hit && t - hit.at < CACHE_TTL_MS) return hit.body;
    if (live && !takeLive()) return fail(reply, req.id, 'RATE_LIMITED', '解説の取得が混み合っています。しばらくしてからやり直してください。', true);
    let result: GuideResult;
    try {
      const budget = new CallBudget({ maxCalls: 3, quota: controls.quota, gate: controls.gate });
      result = await source.guide({ place: known.place, title: known.place.name, lang, number: 1 }, budget);
    } catch (e) {
      if (e instanceof PolicyError && e.code === 'VALIDATION_FAILED') return fail(reply, req.id, 'VALIDATION_FAILED', '指定が不正です。');
      return fail(reply, req.id, 'UNAVAILABLE', '解説を取得できませんでした。', true);
    }
    const body = GuideResponse.parse(guideResponse([result], t, live));
    if (body.dataStatus === 'unavailable') return fail(reply, req.id, 'UNAVAILABLE', body.reason ?? '解説を取得できませんでした。', true);
    // Cache only items whose provenance allows storing; an empty result is never cached.
    if (body.items.length > 0 && body.items.every(i => i.provenance.mayStore)) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: t, body });
    }
    return body;
  });
}
