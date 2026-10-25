/** Which task / GitHub Issue the current screen belongs to, so a reviewer knows where to comment (UI approval). */
export interface ScreenInfo { code: string; name: string; issue: number | null; note?: string }

export const ISSUE_BASE = 'https://github.com/jphacks/tkb_2627/issues/';
export const UI_GUIDE_URL = 'https://github.com/jphacks/tkb_2627/blob/main/docs/ui/UI_CHECK_GUIDE.md';

export function screenFor(hash: string, pathname = '/'): ScreenInfo {
  if (pathname === '/invite') return { code: 'U08', name: 'SNS・グループ（招待リンク）', issue: 36 };
  const trip = /^#\/(?:mock\/)?trips\/[^/]+\/(map|edit|travel|guide|print)(?:[?/].*)?$/.exec(hash);
  if (trip) {
    switch (trip[1]) {
      case 'map':
      case 'edit': return { code: 'U04/U06', name: '地図と旅程の編集', issue: 34 };
      case 'travel': return { code: 'U06', name: '旅行中（再計画）', issue: 34 };
      case 'guide': return { code: 'U07', name: '現在地とガイド', issue: 35 };
      default: return { code: 'E01', name: 'しおり印刷・PDF', issue: 37 };
    }
  }
  if (hash === '#conditions') return { code: 'U03', name: '条件入力', issue: 31 };
  if (hash === '#generate') return { code: 'U05', name: '旅行の計画（生成の進捗・候補の比較）', issue: 33, note: '最初の入力欄は U03（Issue #31）' };
  if (hash === '#social') return { code: 'U08', name: 'SNS・グループ', issue: 36 };
  if (hash === '#u01') return { code: 'U01', name: '最初の試作（確認不要）', issue: null };
  if (hash === '#dev-shell') return { code: '開発用', name: '骨格（確認不要）', issue: null };
  return { code: 'U13', name: 'ホーム', issue: 218 };
}
