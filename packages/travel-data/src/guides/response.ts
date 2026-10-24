import type { GuideItem, GuideResponse } from '@tkb/contracts';
import type { GuideResult } from './wikipedia.ts';

/**
 * K19 GuideResponse from per-place results. Empty and failed are different states (K19): no items because nothing
 * was found is `unknown` with reason 'not_found'; no items because every fetch failed is `unavailable`.
 */
export function guideResponse(results: readonly GuideResult[], fetchedAtMs: number, live: boolean): GuideResponse {
  const items: GuideItem[] = results.flatMap(r => (r.item ? [r.item] : []));
  const failed = results.filter(r => r.reason === 'rate_limited' || r.reason === 'provider_unavailable').length;
  const fetchedAt = new Date(fetchedAtMs).toISOString().replace(/\.000Z$/, 'Z');
  if (items.length > 0) {
    return { items, dataStatus: live ? 'verified' : 'fixture', reason: failed > 0 ? `${failed}件の解説を取得できませんでした` : null, fetchedAt };
  }
  if (results.length > 0 && failed === results.length) return { items: [], dataStatus: 'unavailable', reason: '解説の取得に失敗しました', fetchedAt };
  return { items: [], dataStatus: 'unknown', reason: results.length === 0 ? null : '該当する解説が見つかりませんでした', fetchedAt };
}
