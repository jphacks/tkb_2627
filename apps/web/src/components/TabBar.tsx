import type { Tab } from '../screens/flow.ts';
import './u01.css';

const TABS: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'trips', label: '旅程', icon: '▤' },
  { tab: 'new', label: '新規作成', icon: '＋' },
  { tab: 'feed', label: 'フィード', icon: '≡' },
];

/** Bottom tab bar. Real buttons (keyboard focusable), each at least 44px tall. */
export function TabBar({ active, onSelect }: { active: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <nav className="u1-tabbar" aria-label="メインメニュー">
      {TABS.map(t => (
        <button key={t.tab} type="button" className="u1-tabbtn" aria-current={t.tab === active ? 'page' : undefined}
          onClick={() => onSelect(t.tab)}>
          <span aria-hidden="true" className="u1-tabicon">{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
