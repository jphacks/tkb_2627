import { GuideItem, GuideResponse } from '@tkb/contracts';
import { kanazawaPlaces } from '@tkb/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { CallBudget, DailyQuota, Gate } from '../policy/budget.ts';
import { SAFE_DEFAULT_LIMITS, SKU } from '../policy/limits.ts';
import { allowedImageUrl, normalizeLicense, photoFrom, plainText } from './content.ts';
import { FixtureGuideSource } from './fixture.ts';
import { guideResponse } from './response.ts';
import { commonsFileName, WikipediaGuideSource } from './wikipedia.ts';

const NOW = Date.parse('2026-10-25T00:00:00Z');
const budget = (over: Partial<ConstructorParameters<typeof CallBudget>[0]> = {}) =>
  new CallBudget({ maxCalls: 8, quota: new DailyQuota(SAFE_DEFAULT_LIMITS.dailyPerSku, () => NOW), gate: new Gate(2), retryDelayMs: () => 0, ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const kenrokuen = kanazawaPlaces[1]!;
const IMG = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Kenroku-en_garden.jpg';

// Shapes per the Wikipedia REST summary (extract, originalimage) and Commons imageinfo (thumburl, extmetadata).
const summary = { type: 'standard', title: '兼六園', extract: '兼六園は、石川県金沢市にある日本庭園。<b>日本三名園</b>の一つ。', originalimage: { source: IMG } };
const commons = (license: string | undefined, artist: string | undefined, thumburl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Kenroku-en_garden.jpg/640px-Kenroku-en_garden.jpg') => ({
  query: { pages: { '1': { imageinfo: [{ thumburl, extmetadata: { ...(license ? { LicenseShortName: { value: license } } : {}), ...(artist ? { Artist: { value: artist } } : {}) } }] } } },
});
function source(responses: ((url: string) => Response)[]) {
  let i = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request) => responses[Math.min(i++, responses.length - 1)]!(String(url)));
  return { s: new WikipediaGuideSource({ fetch: fetchMock as unknown as typeof fetch, now: () => NOW }), fetchMock };
}
const req = { place: kenrokuen, title: '兼六園', lang: 'ja', number: 1 };

describe('content helpers', () => {
  it('strips HTML, scripts and entities to plain text, and cuts at a sentence end (HTML除去)', () => {
    expect(plainText('<p>兼六園&amp;庭園<script>alert(1)</script><style>p{}</style> &#x65E5;&#26412;</p>')).toBe('兼六園&庭園 日本');
    expect(plainText('<img src=x onerror=alert(1)>')).toBeNull();
    expect(plainText('一文目。二文目。' + 'あ'.repeat(30), 12)).toBe('一文目。二文目。');
    expect(plainText('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('accepts only https image URLs on allowed hosts (外部URL制限)', () => {
    expect(allowedImageUrl(IMG)).toBe(IMG);
    expect(allowedImageUrl('https://thumb.wikimedia.org/x/640px-a.jpg?x=1')).toBe('https://thumb.wikimedia.org/x/640px-a.jpg?x=1');
    for (const bad of ['http://upload.wikimedia.org/x.jpg', 'https://evil.example/x.jpg', 'https://user:pw@upload.wikimedia.org/x.jpg', 'https://upload.wikimedia.org:8443/x.jpg', 'javascript:alert(1)', 'data:image/png;base64,AA', '']) {
      expect(allowedImageUrl(bad), bad).toBeNull();
    }
  });

  it('keeps only licences that allow reuse with credit', () => {
    expect(normalizeLicense('CC BY-SA 4.0')).toBe('CC BY-SA 4.0');
    expect(normalizeLicense('cc-by-3.0')).toBe('CC BY 3.0');
    expect(normalizeLicense('CC BY 2.5')).toBe('CC BY 2.5');
    expect(normalizeLicense('CC BY-SA 2.1 jp')).toBe('CC BY-SA 2.1 JP');
    expect(normalizeLicense('CC0')).toBe('CC0');
    expect(normalizeLicense('Public domain')).toBe('Public domain');
    for (const bad of ['Fair use', 'All rights reserved', 'CC BY-NC 4.0', 'CC BY-ND 4.0', 'CC BY 4.0 NC', 'CC BY 4.0 nd-xx', '', undefined]) expect(normalizeLicense(bad), String(bad)).toBeNull();
  });

  it('builds a photo only with URL, licence and author all known (画像権利欠落)', () => {
    expect(photoFrom({ url: IMG, artist: '<a href="//x">Taro</a>', licenseShortName: 'CC BY-SA 4.0' })).toEqual({
      photo: { url: IMG, attribution: 'Taro / Wikimedia Commons', license: 'CC BY-SA 4.0' },
      rejected: null,
    });
    expect(photoFrom({ url: IMG, artist: undefined, licenseShortName: 'Public domain' }).photo).toMatchObject({ attribution: 'Wikimedia Commons' });
    expect(photoFrom({ url: IMG, artist: 'Taro', licenseShortName: undefined }).rejected).toBe('license_missing');
    expect(photoFrom({ url: IMG, artist: 'Taro', licenseShortName: 'Fair use' }).rejected).toBe('license_not_allowed');
    expect(photoFrom({ url: IMG, artist: '', licenseShortName: 'CC BY 4.0' }).rejected).toBe('attribution_missing');
    expect(photoFrom({ url: IMG, artist: 'Unknown author', licenseShortName: 'CC BY 4.0' }).rejected).toBe('attribution_missing');
    expect(photoFrom({ url: 'https://evil.example/x.jpg', artist: 'Taro', licenseShortName: 'CC BY 4.0' }).rejected).toBe('url_not_allowed');
    expect(photoFrom({ url: null, artist: 'Taro', licenseShortName: 'CC BY 4.0' }).rejected).toBe('no_image');
  });

  it('reads the Commons file name from upload URLs', () => {
    expect(commonsFileName(IMG)).toBe('Kenroku-en_garden.jpg');
    expect(commonsFileName('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/K%C5%8D.jpg/640px-K%C5%8D.jpg')).toBe('Kō.jpg');
    expect(commonsFileName('https://example.com/x.jpg')).toBeNull();
    // Live summaries add tracking queries; they are not part of the file name.
    expect(commonsFileName(`${IMG}?utm_source=ja.wikipedia.org&utm_campaign=api`)).toBe('Kenroku-en_garden.jpg');
    expect(commonsFileName('not a url')).toBeNull();
  });
});

describe('WikipediaGuideSource', () => {
  it('returns a K19 item with plain description, licensed photo and Wikipedia attribution (出典表示)', async () => {
    const { s, fetchMock } = source([() => json(summary), () => json(commons('CC BY-SA 4.0', '<span>Taro</span>'))]);
    const q = new DailyQuota(SAFE_DEFAULT_LIMITS.dailyPerSku, () => NOW);
    const r = await s.guide(req, budget({ quota: q }));
    expect(r.reason).toBeNull();
    expect(GuideItem.safeParse(r.item).success).toBe(true);
    expect(r.item).toMatchObject({
      number: 1,
      placeId: 'fx_kenrokuen',
      kind: 'spot',
      description: '兼六園は、石川県金沢市にある日本庭園。 日本三名園 の一つ。',
      photo: { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Kenroku-en_garden.jpg/640px-Kenroku-en_garden.jpg', attribution: 'Taro / Wikimedia Commons', license: 'CC BY-SA 4.0' },
      provenance: { source: 'wikipedia', attribution: 'Wikipedia「兼六園」(ja.wikipedia.org), CC BY-SA 4.0（抜粋・HTML除去）', mayStore: true, mayExport: true, maySendToModel: false },
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent('兼六園')}`);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('commons.wikimedia.org/w/api.php');
    expect(q.remaining(SKU.wikimedia)).toBe(58);
  });

  it('keeps the guide but drops a photo whose rights are missing or not allowed', async () => {
    for (const [meta, why] of [[commons(undefined, 'Taro'), 'license_missing'], [commons('Fair use', 'Taro'), 'license_not_allowed'], [commons('CC BY 4.0', 'Taro', 'https://evil.example/x.jpg'), 'url_not_allowed']] as const) {
      const r = await source([() => json(summary), () => json(meta)]).s.guide(req, budget());
      expect(r.item?.photo).toBeNull();
      expect(r.photoRejected).toBe(why);
    }
    const noImage = await source([() => json({ ...summary, originalimage: undefined })]).s.guide(req, budget());
    expect(noImage).toMatchObject({ item: { photo: null }, photoRejected: 'no_image' });
  });

  it('tells not found from failure, and refuses bad input without a call', async () => {
    expect(await source([() => json({}, 404)]).s.guide(req, budget())).toEqual({ item: null, reason: 'not_found', photoRejected: null });
    expect((await source([() => json({ type: 'disambiguation', extract: 'x' })]).s.guide(req, budget())).reason).toBe('not_found');
    expect((await source([() => json({}, 429)]).s.guide(req, budget())).reason).toBe('rate_limited');
    expect((await source([() => new Response('<html>', { status: 200 })]).s.guide(req, budget())).reason).toBe('provider_unavailable');
    const { s, fetchMock } = source([() => json(summary)]);
    for (const bad of [{ ...req, lang: 'ja.evil' }, { ...req, title: '' }, { ...req, number: 0 }]) await expect(s.guide(bad, budget())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fixture source and K19 response', () => {
  it('serves B04 descriptions as fixture guides without calls', async () => {
    const b = budget();
    const r = await new FixtureGuideSource().guide(req, b);
    expect(r.item).toMatchObject({ placeId: 'fx_kenrokuen', photo: null, provenance: { source: 'fixture' } });
    expect((await new FixtureGuideSource().guide({ ...req, place: kanazawaPlaces[2]! }, b)).reason).toBe('not_found');
    expect(b.callsUsed).toBe(0);
  });

  it('distinguishes empty from failed (K19)', async () => {
    const ok = await new FixtureGuideSource().guide(req, budget());
    const res = guideResponse([ok, { item: null, reason: 'provider_unavailable', photoRejected: null }], NOW, false);
    expect(GuideResponse.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ dataStatus: 'fixture', fetchedAt: '2026-10-25T00:00:00Z' });
    expect(res.reason).toContain('1件');
    expect(guideResponse([{ item: null, reason: 'provider_unavailable', photoRejected: null }], NOW, true)).toMatchObject({ items: [], dataStatus: 'unavailable' });
    expect(guideResponse([{ item: null, reason: 'not_found', photoRejected: null }], NOW, true)).toMatchObject({ items: [], dataStatus: 'unknown' });
  });
});
