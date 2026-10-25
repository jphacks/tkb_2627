import { ISSUE_BASE } from './screenBadge.ts';

/** UI approval: every screen to review, reachable in one click (mock trip, no login needed). docs/ui/UI_CHECK_GUIDE.md */
export interface ReviewLink { code: string; name: string; href: string; issueUrl: string }

const MOCK_TRIP = 'fx_trip_kanazawa';
const row = (code: string, name: string, href: string, issue: number): ReviewLink => ({ code, name, href, issueUrl: `${ISSUE_BASE}${issue}` });

export const REVIEW_LINKS: ReviewLink[] = [
  row('U03', '条件入力', '#conditions', 31),
  row('U05', '旅行の計画（進捗・候補の比較・採用）', '#generate', 33),
  row('U04/U06', '地図と旅程の編集', `#/mock/trips/${MOCK_TRIP}/edit`, 34),
  row('U06', '旅行中（再計画）', `#/mock/trips/${MOCK_TRIP}/travel`, 34),
  row('U07', '現在地とガイド', `#/mock/trips/${MOCK_TRIP}/guide`, 35),
  row('U08', 'SNS・グループ', '#social', 36),
];
