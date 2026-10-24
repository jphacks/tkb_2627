import { ISSUE_BASE, UI_GUIDE_URL, screenFor } from './screenBadge.ts';

/** Small fixed label: "この画面: U04 地図と旅程 → Issue #32". Hidden when printing. */
export function ScreenBadge({ hash, pathname }: { hash: string; pathname?: string }) {
  const s = screenFor(hash, pathname);
  return (
    <aside className="screen-badge" aria-label="この画面のタスク番号">
      <span>この画面：<strong>{s.code}</strong> {s.name}</span>
      {s.issue !== null ? (
        <a href={`${ISSUE_BASE}${s.issue}`} target="_blank" rel="noopener noreferrer">感想・指摘は Issue #{s.issue} へ</a>
      ) : null}
      {s.note ? <span className="screen-badge-note">{s.note}</span> : null}
      <a href={UI_GUIDE_URL} target="_blank" rel="noopener noreferrer">確認の手順</a>
    </aside>
  );
}
