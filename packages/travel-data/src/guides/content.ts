import type { Photo } from '@tkb/contracts';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Provider HTML → plain text for K19 descriptions: drops script/style blocks and every tag, decodes entities,
 * collapses whitespace, and cuts at a sentence end within `maxLength` (never mid-word with no marker).
 */
export function plainText(html: string | null | undefined, maxLength = 600): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return end > maxLength / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, maxLength - 1)}…`;
}

/**
 * Image hosts we accept photo URLs from (D07: external URL restriction). Commons serves originals from upload. and,
 * as seen in the D07 live check, scaled thumbnails from thumb.wikimedia.org.
 */
export const ALLOWED_IMAGE_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org'] as const;

/** https URL on an allowed host, or null. No credentials, ports or other schemes. */
export function allowedImageUrl(url: string | null | undefined, hosts: readonly string[] = ALLOWED_IMAGE_HOSTS): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !hosts.includes(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Licences whose images we may show and republish with credit (Commons "LicenseShortName"). Anything else, including
 * "fair use" and unknown, means no photo (R15: image rights missing → not shown).
 */
export function normalizeLicense(shortName: string | null | undefined): string | null {
  const s = plainText(shortName ?? '', 80);
  if (!s) return null;
  if (/^(cc0|cc0 1\.0|public domain|pd(-[a-z0-9-]+)?)$/i.test(s)) return /^cc0/i.test(s) ? 'CC0' : 'Public domain';
  // Versions 1.0-4.0 including 2.1 / 2.5 (CC BY 2.5 was the live Kenrokuen image, D07), optional port such as 'jp'.
  const m = /^cc[- ]by(-sa)?[- ]([1-4]\.[0-9])(?:[- ]([a-z]{2,}))?$/i.exec(s);
  if (m) return `CC BY${m[1] ? '-SA' : ''} ${m[2]}${m[3] ? ` ${m[3].toUpperCase()}` : ''}`;
  return null;
}

export interface ImageMeta {
  url: string | null | undefined;
  artist: string | null | undefined;
  licenseShortName: string | null | undefined;
}

export type PhotoRejection = 'no_image' | 'url_not_allowed' | 'license_missing' | 'license_not_allowed' | 'attribution_missing';

/**
 * A K19 Photo only when every right is known: an allowed https URL, an accepted licence and a credited author.
 * Otherwise null with the reason; nothing is filled in.
 */
export function photoFrom(meta: ImageMeta, source = 'Wikimedia Commons'): { photo: Photo | null; rejected: PhotoRejection | null } {
  if (!meta.url) return { photo: null, rejected: 'no_image' };
  const url = allowedImageUrl(meta.url);
  if (!url) return { photo: null, rejected: 'url_not_allowed' };
  if (!meta.licenseShortName?.trim()) return { photo: null, rejected: 'license_missing' };
  const license = normalizeLicense(meta.licenseShortName);
  if (!license) return { photo: null, rejected: 'license_not_allowed' };
  const artist = plainText(meta.artist, 200);
  if (!artist && license !== 'Public domain' && license !== 'CC0') return { photo: null, rejected: 'attribution_missing' };
  // Public-domain / CC0 images need no author; then only the source is credited (no invented name).
  return { photo: { url, attribution: artist ? `${artist} / ${source}` : source, license }, rejected: null };
}
