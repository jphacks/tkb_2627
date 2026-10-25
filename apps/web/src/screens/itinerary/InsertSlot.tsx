/**
 * U12 (#214, #34 review): a quiet "add here" entry placed between itinerary rows, and before the first and after the
 * last. Collapsed it is a thin divider with a small ＋ (the hit area is 44px tall for touch); pressing it opens a small
 * form in place. On 追加 it calls `onAdd({ title, start?, end? })`; turning that into a K10 add operation (date, time
 * zone, position) is up to the caller (M1's U11). Styles are inline so this file stands alone.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';

export type InsertPosition = 'before-first' | 'between' | 'after-last';

/** What the user asked to add. Times are local wall-clock `HH:MM` strings, when given. */
export interface InsertItem { title: string; start?: string; end?: string }

export interface InsertSlotProps {
  position: InsertPosition;
  onAdd: (item: InsertItem) => void;
  disabled?: boolean;
}

export const TITLE_MAX = 100;
const POSITION_LABEL: Record<InsertPosition, string> = {
  'before-first': '先頭に予定を追加',
  between: 'ここに予定を追加',
  'after-last': '最後に予定を追加',
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Checks the form and builds the item to add, or says in Japanese what to fix. */
export function toInsertItem(form: { title: string; start: string; end: string }): { ok: true; item: InsertItem } | { ok: false; error: string } {
  const title = form.title.trim();
  if (title === '') return { ok: false, error: '予定の名前を入力してください。' };
  if (title.length > TITLE_MAX) return { ok: false, error: `予定の名前は ${TITLE_MAX} 文字までです。` };
  const start = form.start.trim();
  const end = form.end.trim();
  if (start !== '' && !HHMM.test(start)) return { ok: false, error: '開始の時刻は 9:00 のように入力してください。' };
  if (end !== '' && !HHMM.test(end)) return { ok: false, error: '終了の時刻は 9:00 のように入力してください。' };
  if (start !== '' && end !== '' && end <= start) return { ok: false, error: '終了の時刻は、開始より後にしてください。' };
  return { ok: true, item: { title, ...(start ? { start } : {}), ...(end ? { end } : {}) } };
}

const lineStyle: CSSProperties = { flex: 1, height: 0, borderTop: '1px dashed var(--line, #ccc)' };
const plusStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 44, padding: '0 4px', border: 0, background: 'transparent',
  color: 'var(--mut, #666)', font: 'inherit', fontSize: 13, cursor: 'pointer',
};
const dotStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%',
  border: '1px solid var(--line, #ccc)', background: 'var(--card, #fff)', fontSize: 15, lineHeight: 1,
};
const fieldStyle: CSSProperties = { font: 'inherit', fontSize: 14, minHeight: 36, padding: '4px 8px', border: '1px solid var(--line, #ccc)', borderRadius: 6 };

/** The open form; exported so it can be rendered and tested on its own. */
export function InsertForm({ position, onAdd, onCancel, disabled = false }: { position: InsertPosition; onAdd: (item: InsertItem) => void; onCancel: () => void; disabled?: boolean }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const r = toInsertItem({ title, start, end });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onAdd(r.item);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // An Escape that ends an IME composition must not close the form.
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <form
      className="u12-insert-form"
      aria-label={POSITION_LABEL[position]}
      onSubmit={submit}
      onKeyDown={onKeyDown}
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, margin: '4px 0', padding: 8, border: '1px solid var(--line, #ccc)', borderRadius: 8, background: 'var(--card, #fff)' }}
    >
      <label htmlFor={`${id}-t`} style={{ display: 'flex', flexDirection: 'column', fontSize: 12, flex: '1 1 180px' }}>
        予定の名前
        <input id={`${id}-t`} autoFocus required maxLength={TITLE_MAX} value={title} onChange={e => { setTitle(e.target.value); setError(null); }} placeholder="例：ひがし茶屋街" style={fieldStyle} />
      </label>
      <label htmlFor={`${id}-s`} style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
        開始（任意）
        <input id={`${id}-s`} type="time" value={start} onChange={e => { setStart(e.target.value); setError(null); }} style={fieldStyle} />
      </label>
      <label htmlFor={`${id}-e`} style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
        終了（任意）
        <input id={`${id}-e`} type="time" value={end} onChange={e => { setEnd(e.target.value); setError(null); }} style={fieldStyle} />
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" disabled={disabled} style={{ minHeight: 36 }}>追加</button>
        <button type="button" onClick={onCancel} style={{ minHeight: 36 }}>やめる</button>
      </div>
      {error && <p role="alert" style={{ flexBasis: '100%', margin: 0, fontSize: 13, color: 'var(--warn, #b00020)' }}>{error}</p>}
    </form>
  );
}

/** Collapsed: a thin divider with a small ＋. Pressing it opens InsertForm in place; adding or やめる closes it. */
export function InsertSlot({ position, onAdd, disabled = false }: InsertSlotProps) {
  const [open, setOpen] = useState(false);
  // After the form closes, focus goes back to the ＋ so keyboard users stay in place.
  const plus = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!open && returnFocus.current) {
      returnFocus.current = false;
      plus.current?.focus();
    }
  }, [open]);
  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };
  if (open) {
    return (
      <InsertForm
        position={position}
        disabled={disabled}
        onCancel={close}
        onAdd={item => {
          onAdd(item);
          close();
        }}
      />
    );
  }
  const label = POSITION_LABEL[position];
  return (
    <div className="u12-insert-slot" data-position={position}>
      <button ref={plus} type="button" aria-label={label} title={label} disabled={disabled} onClick={() => setOpen(true)} style={{ ...plusStyle, opacity: disabled ? 0.4 : 1 }}>
        <span aria-hidden="true" style={lineStyle} />
        <span aria-hidden="true" style={dotStyle}>＋</span>
        {/* The words show only at the ends, where there is no row on one side to hint at the place. */}
        {position !== 'between' && <span aria-hidden="true">{position === 'before-first' ? '先頭に追加' : '最後に追加'}</span>}
        <span aria-hidden="true" style={lineStyle} />
      </button>
    </div>
  );
}
