import type { ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InsertForm, InsertSlot, TITLE_MAX, toInsertItem } from './InsertSlot.tsx';

const render = (el: ReactElement): string => renderRaw(el).replace(/<!-- -->/g, '');
const noop = () => {};

describe('InsertSlot (U12, #34 review)', () => {
  it('is a quiet ＋ on a divider, labelled for where it adds, before the first, between and after the last', () => {
    const first = render(<InsertSlot position="before-first" onAdd={noop} />);
    const mid = render(<InsertSlot position="between" onAdd={noop} />);
    const last = render(<InsertSlot position="after-last" onAdd={noop} />);
    expect(first).toContain('aria-label="先頭に予定を追加"');
    expect(mid).toContain('aria-label="ここに予定を追加"');
    expect(last).toContain('aria-label="最後に予定を追加"');
    for (const html of [first, mid, last]) {
      expect(html).toContain('＋');
      // Collapsed: no form fields until pressed, so the itinerary stays uncluttered.
      expect(html).not.toContain('<input');
      expect(html).toContain('type="button"');
      // A 44px tall hit area for touch.
      expect(html).toContain('min-height:44px');
    }
    // Words only at the ends; between rows it is just the ＋.
    expect(first).toContain('先頭に追加');
    expect(last).toContain('最後に追加');
    expect(mid).not.toMatch(/>[^<]*追加</);
  });

  it('can be disabled', () => {
    expect(render(<InsertSlot position="between" onAdd={noop} disabled />)).toMatch(/<button[^>]*disabled=""/);
  });
});

describe('InsertForm', () => {
  it('asks for a title and optional start/end times, with 追加 and やめる', () => {
    const html = render(<InsertForm position="between" onAdd={noop} onCancel={noop} />);
    expect(html).toContain('aria-label="ここに予定を追加"');
    expect(html).toContain('予定の名前');
    expect((html.match(/type="time"/g) ?? []).length).toBe(2);
    expect(html).toContain('開始（任意）');
    expect(html).toMatch(/type="submit"[^>]*>追加</);
    expect(html).toContain('>やめる<');
  });
});

describe('toInsertItem', () => {
  it('trims the title and leaves out times that were not given', () => {
    expect(toInsertItem({ title: '  ひがし茶屋街 ', start: '', end: '' })).toEqual({ ok: true, item: { title: 'ひがし茶屋街' } });
    expect(toInsertItem({ title: 'カフェ', start: '14:00', end: '' })).toEqual({ ok: true, item: { title: 'カフェ', start: '14:00' } });
    expect(toInsertItem({ title: 'カフェ', start: '14:00', end: '14:45' })).toEqual({ ok: true, item: { title: 'カフェ', start: '14:00', end: '14:45' } });
  });

  it('says what to fix in Japanese', () => {
    expect(toInsertItem({ title: '   ', start: '', end: '' })).toEqual({ ok: false, error: '予定の名前を入力してください。' });
    expect(toInsertItem({ title: 'x'.repeat(TITLE_MAX + 1), start: '', end: '' }).ok).toBe(false);
    expect(toInsertItem({ title: 'a', start: '25:00', end: '' })).toMatchObject({ ok: false, error: expect.stringContaining('開始') });
    expect(toInsertItem({ title: 'a', start: '', end: '9:5' })).toMatchObject({ ok: false, error: expect.stringContaining('終了') });
    expect(toInsertItem({ title: 'a', start: '15:00', end: '15:00' })).toEqual({ ok: false, error: '終了の時刻は、開始より後にしてください。' });
  });
});
