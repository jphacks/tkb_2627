/** U03 time zone picker helpers: grouped options with Japanese city names and the current UTC offset. */

export const DEFAULT_ZONE = 'Asia/Tokyo';

export const COMMON_ZONES = [
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Taipei', 'Asia/Shanghai', 'Asia/Bangkok', 'Asia/Singapore',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome',
  'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Australia/Sydney',
] as const;

const CITY_JA: Record<string, string> = {
  'Asia/Tokyo': '東京', 'Asia/Seoul': 'ソウル', 'Asia/Taipei': '台北', 'Asia/Shanghai': '上海', 'Asia/Bangkok': 'バンコク',
  'Asia/Singapore': 'シンガポール', 'Asia/Hong_Kong': '香港', 'Asia/Dubai': 'ドバイ', 'Asia/Kolkata': 'ムンバイ・デリー',
  'Asia/Manila': 'マニラ', 'Asia/Ho_Chi_Minh': 'ホーチミン', 'Asia/Jakarta': 'ジャカルタ', 'Asia/Kuala_Lumpur': 'クアラルンプール',
  'Europe/London': 'ロンドン', 'Europe/Paris': 'パリ', 'Europe/Berlin': 'ベルリン', 'Europe/Rome': 'ローマ', 'Europe/Madrid': 'マドリード',
  'Europe/Amsterdam': 'アムステルダム', 'Europe/Vienna': 'ウィーン', 'Europe/Zurich': 'チューリッヒ', 'Europe/Istanbul': 'イスタンブール',
  'Europe/Moscow': 'モスクワ', 'America/New_York': 'ニューヨーク', 'America/Los_Angeles': 'ロサンゼルス', 'America/Chicago': 'シカゴ',
  'America/Denver': 'デンバー', 'America/Toronto': 'トロント', 'America/Vancouver': 'バンクーバー', 'America/Mexico_City': 'メキシコシティ',
  'America/Sao_Paulo': 'サンパウロ', 'Pacific/Honolulu': 'ホノルル', 'Pacific/Guam': 'グアム', 'Pacific/Auckland': 'オークランド',
  'Australia/Sydney': 'シドニー', 'Australia/Melbourne': 'メルボルン', 'Africa/Cairo': 'カイロ',
};

/** 地域名（部分一致）→ IANA。先に一致したものを使う。 */
const AREA_ZONE: Array<[RegExp, string]> = [
  [/金沢|東京|日本|大阪|京都|北海道|札幌|福岡|沖縄|名古屋|横浜|広島|仙台|奈良|神戸|japan|tokyo|kanazawa|osaka|kyoto/i, 'Asia/Tokyo'],
  [/ソウル|韓国|釜山|seoul|korea/i, 'Asia/Seoul'],
  [/台北|台湾|taipei|taiwan/i, 'Asia/Taipei'],
  [/上海|北京|中国|shanghai|beijing|china/i, 'Asia/Shanghai'],
  [/バンコク|タイ|bangkok|thailand/i, 'Asia/Bangkok'],
  [/シンガポール|singapore/i, 'Asia/Singapore'],
  [/ロンドン|イギリス|英国|london|england/i, 'Europe/London'],
  [/パリ|フランス|paris|france/i, 'Europe/Paris'],
  [/ベルリン|ドイツ|berlin|germany/i, 'Europe/Berlin'],
  [/ローマ|イタリア|rome|italy/i, 'Europe/Rome'],
  [/ニューヨーク|new york/i, 'America/New_York'],
  [/ロサンゼルス|los angeles/i, 'America/Los_Angeles'],
  [/ハワイ|ホノルル|hawaii|honolulu/i, 'Pacific/Honolulu'],
  [/シドニー|オーストラリア|sydney|australia/i, 'Australia/Sydney'],
];

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 地域の文字列から既知のタイムゾーンを推定する。分からなければ null。 */
export function zoneForArea(area: string): string | null {
  const a = area.trim();
  if (a === '') return null;
  return AREA_ZONE.find(([re]) => re.test(a))?.[1] ?? null;
}

/** 「UTC+9」「UTC-5」「UTC+5:30」。 */
export function utcOffsetLabel(zone: string, now: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(part);
    if (!m) return 'UTC';
    if (!m[1]) return 'UTC±0';
    const h = String(Number(m[2]));
    return `UTC${m[1]}${h}${m[3] === '00' ? '' : `:${m[3]}`}`;
  } catch {
    return 'UTC';
  }
}

/** 「東京（Asia/Tokyo, UTC+9）」。日本語名が無ければ「Asia/Tokyo（UTC+9）」。 */
export function zoneLabel(zone: string, now: Date = new Date()): string {
  const off = utcOffsetLabel(zone, now);
  const city = CITY_JA[zone];
  return city ? `${city}（${zone}, ${off}）` : `${zone}（${off}）`;
}

export interface ZoneGroup {
  label: string;
  zones: Array<{ value: string; label: string }>;
}

const REGION_JA: Record<string, string> = {
  Asia: 'アジア', Europe: 'ヨーロッパ', America: 'アメリカ', Pacific: '太平洋', Australia: 'オーストラリア',
  Africa: 'アフリカ', Atlantic: '大西洋', Indian: 'インド洋', Antarctica: '南極', Arctic: '北極', Etc: 'その他', UTC: 'その他',
};

function allZones(): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  let list: string[] = [];
  try { list = fn ? fn('timeZone') : []; } catch { list = []; }
  return list.filter(isValidZone);
}

/** 「よく使う」→ 地域別。common 以外は supportedValuesOf から。 */
export function buildZoneGroups(now: Date = new Date(), zones: string[] = allZones()): ZoneGroup[] {
  const common = COMMON_ZONES.filter(isValidZone);
  const groups: ZoneGroup[] = [{ label: 'よく使う', zones: common.map(z => ({ value: z, label: zoneLabel(z, now) })) }];
  const commonSet = new Set<string>(common);
  const byRegion = new Map<string, string[]>();
  for (const z of zones) {
    if (commonSet.has(z)) continue;
    const region = z.includes('/') ? z.slice(0, z.indexOf('/')) : 'UTC';
    byRegion.set(region, [...(byRegion.get(region) ?? []), z]);
  }
  for (const [region, list] of [...byRegion].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({ label: `${REGION_JA[region] ?? region}（${region}）`, zones: list.map(z => ({ value: z, label: zoneLabel(z, now) })) });
  }
  return groups;
}
