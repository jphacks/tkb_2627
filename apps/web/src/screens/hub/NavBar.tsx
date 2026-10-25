import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import './hub.css';
import { backTarget, navModel, nextDepth } from './nav.ts';

/** Counts in-app hash navigations via history.state so 「戻る」 never leaves the app. */
function useAppDepth(hash: string): number {
  const prev = useRef(-1);
  const [depth, setDepth] = useState(0);
  useEffect(() => {
    let d = prev.current + 1;
    try {
      const st = (history.state ?? {}) as { tkbDepth?: unknown };
      d = nextDepth(prev.current, st.tkbDepth);
      if (typeof st.tkbDepth !== 'number') history.replaceState({ ...st, tkbDepth: d }, '');
    } catch { /* history unavailable */ }
    prev.current = d;
    setDepth(d);
  }, [hash]);
  return depth;
}

export function NavBar({ hash, pathname = '/' }: { hash: string; pathname?: string }) {
  const model = navModel(hash, pathname);
  const depth = useAppDepth(hash);
  if (!model.visible) return null;
  const onBack = (e: MouseEvent) => {
    e.preventDefault();
    if (backTarget(depth) === 'history') history.back();
    else location.hash = '#home';
  };
  return (
    <header className="nav-bar">
      <div className="nav-row">
        <a href="#home" className="nav-btn" onClick={onBack} aria-label="前のページへ戻る">← 戻る</a>
        <span className="nav-title">{model.title ?? ''}</span>
        <a href="#home" className="nav-btn">ホーム</a>
      </div>
      {model.tabs.length > 0 && (
        <nav className="nav-tabs" aria-label="旅程の画面">
          {model.tabs.map((t) => (
            <a key={t.key} href={t.href} className={`nav-tab${t.current ? ' nav-tab-cur' : ''}`} aria-current={t.current ? 'page' : undefined}>{t.label}</a>
          ))}
        </nav>
      )}
    </header>
  );
}
