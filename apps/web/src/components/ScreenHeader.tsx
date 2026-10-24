import type { ReactNode } from 'react';
import './u01.css';

/** Screen title with an optional 戻る button. */
export function ScreenHeader({ title, onBack, children }: { title: string; onBack?: () => void; children?: ReactNode }) {
  return (
    <header className="u1-header">
      {onBack && (
        <button type="button" className="btn u1-back" onClick={onBack} aria-label="前の画面に戻る">← 戻る</button>
      )}
      <h1 className="u1-title">{title}</h1>
      {children}
    </header>
  );
}
