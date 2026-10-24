import type { GuideItem, PlaceInfo } from '@tkb/contracts';
import { PolicyError, type CallBudget } from '../policy/budget.ts';
import { SKU } from '../policy/limits.ts';
import { provenanceFor } from '../policy/retention.ts';
import { photoFrom, plainText, type PhotoRejection } from './content.ts';

/** Wikimedia asks API clients to identify themselves (User-Agent policy). */
const USER_AGENT = 'tkb_2627/0.1 (JPHacks travel planner; https://github.com/jphacks/tkb_2627)';

export interface GuideRequest {
  /** The place the guide is for; its placeId and location are kept in the item. */
  place: PlaceInfo;
  /** Wikipedia article title, chosen by the caller (e.g. from the trip's place list); never guessed here. */
  title: string;
  /** Wikipedia language edition, e.g. 'ja', 'fr'. */
  lang: string;
  /** 1-based number for the guide list / map pins. */
  number: number;
}

export type GuideUnknownReason = 'not_found' | 'rate_limited' | 'provider_unavailable';

export interface GuideResult {
  item: GuideItem | null;
  reason: GuideUnknownReason | null;
  /** Why the photo was left out, when there is an item without one. */
  photoRejected: PhotoRejection | null;
}

/** K19 guide source: Wikipedia summaries (text) and Wikimedia Commons image metadata (licence, author). */
export interface GuideSource {
  guide(request: GuideRequest, budget: CallBudget): Promise<GuideResult>;
}

interface Summary {
  type?: string;
  title?: string;
  extract?: string;
  originalimage?: { source?: string };
  thumbnail?: { source?: string };
}
interface CommonsImageInfo {
  thumburl?: string;
  url?: string;
  extmetadata?: { LicenseShortName?: { value?: string }; Artist?: { value?: string } };
}

export interface WikipediaGuideOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** Commons file name from an upload.wikimedia.org URL (…/commons/a/ab/Name.jpg or …/thumb/a/ab/Name.jpg/640px-…). */
export function commonsFileName(url: string | undefined): string | null {
  let path: string;
  try {
    // Only the path: live summary URLs carry tracking queries (?utm_source=…), found in the D07 live check.
    path = new URL(url ?? '').pathname;
  } catch {
    return null;
  }
  const m = /\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/.exec(path);
  try {
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

/**
 * Wikipedia + Commons guide adapter (D07, R15/R16). Each request makes at most two calls through the input's
 * CallBudget: the page summary, then the image's licence metadata. The description is plain text; the photo is kept
 * only with an allowed URL, an accepted licence and an author (photoFrom). Text is CC BY-SA 4.0 (provenance says so).
 */
export class WikipediaGuideSource implements GuideSource {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(options: WikipediaGuideOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async guide(request: GuideRequest, budget: CallBudget): Promise<GuideResult> {
    const { place, lang, number } = request;
    const title = request.title.trim();
    if (!/^[a-z]{2,3}(-[a-z]+)?$/.test(lang)) throw new PolicyError('VALIDATION_FAILED', 'invalid Wikipedia language', false);
    if (!title || title.length > 200) throw new PolicyError('VALIDATION_FAILED', 'title must be 1-200 characters', false);
    if (!Number.isInteger(number) || number < 1) throw new PolicyError('VALIDATION_FAILED', 'number must be a positive integer', false);

    let summary: Summary | null;
    try {
      summary = await this.getJson<Summary>(
        budget,
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      );
    } catch (e) {
      return { item: null, reason: failure(e), photoRejected: null };
    }
    const description = plainText(summary?.extract);
    if (!summary || summary.type === 'disambiguation' || !description) return { item: null, reason: 'not_found', photoRejected: null };

    let photo: GuideItem['photo'] = null;
    let photoRejected: PhotoRejection | null = 'no_image';
    const file = commonsFileName(summary.originalimage?.source ?? summary.thumbnail?.source);
    if (file) {
      try {
        const info = await this.getJson<{ query?: { pages?: Record<string, { imageinfo?: CommonsImageInfo[] }> } }>(
          budget,
          `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=640&titles=${encodeURIComponent(`File:${file}`)}`,
        );
        const ii = Object.values(info?.query?.pages ?? {})[0]?.imageinfo?.[0];
        const result = photoFrom({ url: ii?.thumburl ?? ii?.url, artist: ii?.extmetadata?.Artist?.value, licenseShortName: ii?.extmetadata?.LicenseShortName?.value });
        photo = result.photo;
        photoRejected = result.rejected;
      } catch (e) {
        if (e instanceof PolicyError && e.code === 'CANCELLED') throw e;
        photoRejected = 'license_missing'; // licence could not be read: no photo
      }
    }
    const item: GuideItem = {
      number,
      placeId: place.placeId,
      name: place.name,
      kind: 'spot',
      location: place.location,
      description,
      photo,
      // CC BY-SA asks for the source of the work: credit the article, not only "Wikipedia". The text is an excerpt.
      provenance: { ...provenanceFor('wikipedia', this.now()), attribution: `Wikipedia「${summary.title ?? title}」(${lang}.wikipedia.org), CC BY-SA 4.0（抜粋・HTML除去）` },
    };
    return { item, reason: null, photoRejected: photo ? null : photoRejected };
  }

  /** GET through the budget; 404 → null (not found), other failures → PolicyError. */
  private getJson<T>(budget: CallBudget, url: string): Promise<T | null> {
    return budget.run(SKU.wikimedia, url, async signal => {
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers: { 'Api-User-Agent': USER_AGENT, 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new PolicyError('PROVIDER_UNAVAILABLE', 'provider unavailable', true);
      }
      if (res.status === 404) return null;
      if (res.status === 429) throw new PolicyError('PROVIDER_RATE_LIMIT', 'provider rate limit', false);
      if (!res.ok) throw new PolicyError('PROVIDER_UNAVAILABLE', `provider error ${res.status}`, res.status >= 500);
      const parsed: unknown = await res.json().catch(() => undefined);
      if (typeof parsed !== 'object' || parsed === null) throw new PolicyError('PROVIDER_UNAVAILABLE', 'unreadable provider response', false);
      return parsed as T;
    });
  }
}

function failure(e: unknown): GuideUnknownReason {
  if (e instanceof PolicyError && e.code === 'PROVIDER_RATE_LIMIT') return 'rate_limited';
  if (e instanceof PolicyError && e.code === 'PROVIDER_UNAVAILABLE') return 'provider_unavailable';
  throw e;
}
